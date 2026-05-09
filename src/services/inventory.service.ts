import {
  findInventoryByUser,
  findInventoryItemById,
  insertInventoryItem,
  insertInventoryBatch,
  updateInventoryItem,
  deleteInventoryItem,
  fetchProductPrices,
  CreateInventoryInput,
  UpdateInventoryInput,
  InventoryRow,
  GradingCompany,
  ItemType,
} from "../repositories/inventory.repository";
import { batchResolveMarketValues } from "./pricing.service";
import { supabaseAdmin } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MarketValue {
  marketPrice: number | null;
  source: string | null;
}

export interface InventoryItemWithValue extends InventoryRow {
  marketValue: MarketValue;
  gainLoss: number | null;
  gainLossPct: number | null;
}

export interface InventorySummary {
  totalItems: number;
  rawCards: number;
  gradedCards: number;
  sealedProducts: number;
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPct: number | null;
}

// ─── Price resolution ─────────────────────────────────────────────────────────

// Determine the best market price for an inventory item
const resolveMarketValue = (
  item: InventoryRow,
  cardPrices: Map<string, number | null>,
  productPrices: Map<string, number>,
): MarketValue => {
  // Sealed product
  if (item.item_type === "sealed_product" && item.product_id) {
    const price = productPrices.get(item.product_id) ?? null;
    return { marketPrice: price, source: price ? "tcgplayer" : null };
  }

  // Raw or graded card
  if (item.card_id) {
    const price = cardPrices.get(item.card_id) ?? null;
    return {
      marketPrice: price,
      source: price ? "tcgplayer" : null,
    };
  }

  return { marketPrice: null, source: null };
};

// ─── Service functions ────────────────────────────────────────────────────────

export const getInventory = async (
  userId: string,
): Promise<{ items: InventoryItemWithValue[]; summary: InventorySummary }> => {
  const rows = await findInventoryByUser(userId);

  if (!rows.length) {
    return {
      items: [],
      summary: {
        totalItems: 0,
        rawCards: 0,
        gradedCards: 0,
        sealedProducts: 0,
        totalCostBasis: 0,
        totalMarketValue: 0,
        totalGainLoss: 0,
        totalGainLossPct: null,
      },
    };
  }

  // Collect all IDs for batch price fetching
  const cardIds = [
    ...new Set(rows.filter((r) => r.card_id).map((r) => r.card_id!)),
  ];
  const productIds = [
    ...new Set(
      rows
        .filter((r) => r.product_id && r.item_type === "sealed_product")
        .map((r) => r.product_id!),
    ),
  ];

  // Single DB query for all card prices (reads from market_prices table)
  const [cardPrices, productPrices] = await Promise.all([
    batchResolveMarketValues(cardIds),
    fetchProductPrices(productIds), // existing function reads product_price_cache
  ]);

  let totalCostBasis = 0;
  let totalMarketValue = 0;
  let rawCards = 0,
    gradedCards = 0,
    sealedProducts = 0;

  const items: InventoryItemWithValue[] = rows.map((row) => {
    const marketValue = resolveMarketValue(row, cardPrices, productPrices);

    const gainLoss =
      marketValue.marketPrice !== null && row.purchase_price !== null
        ? marketValue.marketPrice - row.purchase_price
        : null;

    const gainLossPct =
      gainLoss !== null && row.purchase_price && row.purchase_price > 0
        ? (gainLoss / row.purchase_price) * 100
        : null;

    if (row.purchase_price) totalCostBasis += row.purchase_price;
    if (marketValue.marketPrice) totalMarketValue += marketValue.marketPrice;

    if (row.item_type === "raw_card") rawCards++;
    else if (row.item_type === "graded_card") gradedCards++;
    else if (row.item_type === "sealed_product") sealedProducts++;

    return { ...row, marketValue, gainLoss, gainLossPct };
  });

  const totalGainLoss = totalMarketValue - totalCostBasis;
  const totalGainLossPct =
    totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : null;

  return {
    items,
    summary: {
      totalItems: rows.length,
      rawCards,
      gradedCards,
      sealedProducts,
      totalCostBasis,
      totalMarketValue,
      totalGainLoss,
      totalGainLossPct,
    },
  };
};

export const addInventoryItem = async (
  userId: string,
  input: CreateInventoryInput,
): Promise<InventoryRow> => {
  // Validate required fields per type
  if (input.itemType === "raw_card" && !input.cardId) {
    throw { status: 400, message: "card_id is required for raw cards" };
  }
  if (input.itemType === "graded_card") {
    if (!input.cardId)
      throw { status: 400, message: "card_id is required for graded cards" };
    if (!input.gradingCompany)
      throw {
        status: 400,
        message: "grading_company is required for graded cards",
      };
    if (!input.grade)
      throw { status: 400, message: "grade is required for graded cards" };
  }
  if (input.itemType === "sealed_product" && !input.productId) {
    throw {
      status: 400,
      message: "product_id is required for sealed products",
    };
  }

  // Default is_sealed to true for products
  if (input.itemType === "sealed_product" && input.isSealed === undefined) {
    input.isSealed = true;
  }

  return insertInventoryItem(userId, input);
};

export const editInventoryItem = async (
  id: string,
  userId: string,
  input: UpdateInventoryInput,
): Promise<InventoryRow> => {
  const item = await findInventoryItemById(id);
  if (!item) throw { status: 404, message: "Inventory item not found" };
  if (item.user_id !== userId) throw { status: 403, message: "Access denied" };

  return updateInventoryItem(id, userId, input);
};

export const removeInventoryItem = async (
  id: string,
  userId: string,
): Promise<void> => {
  const item = await findInventoryItemById(id);
  if (!item) throw { status: 404, message: "Inventory item not found" };
  if (item.user_id !== userId) throw { status: 403, message: "Access denied" };

  await deleteInventoryItem(id, userId);
};

// ─── Open sealed product ──────────────────────────────────────────────────────

export interface PulledCard {
  cardId: string;
  purchasePrice?: number | null;
  notes?: string | null;
}

export const openSealedProduct = async (
  id: string,
  userId: string,
  pulledCards: PulledCard[],
): Promise<{ inserted: number }> => {
  const item = await findInventoryItemById(id);
  if (!item) throw { status: 404, message: "Inventory item not found" };
  if (item.user_id !== userId) throw { status: 403, message: "Access denied" };
  if (item.item_type !== "sealed_product") {
    throw { status: 400, message: "Item is not a sealed product" };
  }
  if (!item.is_sealed) {
    throw { status: 400, message: "Product has already been opened" };
  }

  if (!pulledCards.length) {
    throw {
      status: 400,
      message: "At least one pulled card is required to open a product",
    };
  }

  // Validate all card IDs exist
  const { supabaseAdmin } = await import("../lib/supabase");
  const cardIds = pulledCards.map((c) => c.cardId);
  const { data: cards, error } = await supabaseAdmin
    .from("cards")
    .select("id")
    .in("id", cardIds);

  if (error) throw error;
  const foundIds = new Set((cards ?? []).map((c) => c.id));
  const missing = cardIds.filter((id) => !foundIds.has(id));
  if (missing.length) {
    throw { status: 400, message: `Unknown card IDs: ${missing.join(", ")}` };
  }

  // Insert pulled cards as raw inventory items
  const newItems: CreateInventoryInput[] = pulledCards.map((c) => ({
    itemType: "raw_card" as const,
    cardId: c.cardId,
    purchasePrice: c.purchasePrice ?? null,
    notes: c.notes ?? null,
  }));

  await insertInventoryBatch(userId, newItems);

  // Delete the sealed product from inventory
  await deleteInventoryItem(id, userId);

  return { inserted: pulledCards.length };
};

// ─── Portfolio snapshot helper ────────────────────────────────────────────────
// Called by the portfolio cron to record today's total value

export const getCurrentTotalValue = async (userId: string): Promise<number> => {
  const { summary } = await getInventory(userId);
  return summary.totalMarketValue;
};

export interface BatchItem {
  itemType: ItemType;
  cardId?: string | null;
  productId?: string | null;
  variantType?: string | null;
  gradingCompany?: GradingCompany | null;
  grade?: string | null;
  isSealed?: boolean | null;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  notes?: string | null;
}

export const batchAddInventoryItems = async (
  userId: string,
  items: BatchItem[],
): Promise<number> => {
  if (!items.length) return 0;

  const rows = items.map((item) => ({
    user_id: userId,
    item_type: item.itemType,
    card_id: item.cardId ?? null,
    product_id: item.productId ?? null,
    variant_type: item.variantType ?? null,
    grading_company: item.gradingCompany ?? null,
    grade: item.grade ?? null,
    is_sealed: item.isSealed ?? null,
    purchase_price: item.purchasePrice ?? null,
    purchase_date: item.purchaseDate ?? null,
    notes: item.notes ?? null,
  }));

  // Insert in chunks of 200 to avoid payload limits
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("inventory")
      .insert(rows.slice(i, i + CHUNK));
    if (error) {
      console.error("[InventoryService] batchAdd error:", error);
      throw error;
    }
  }

  return rows.length;
};

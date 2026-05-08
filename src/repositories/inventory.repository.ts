import { supabaseAdmin } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemType = "raw_card" | "graded_card" | "sealed_product";
export type GradingCompany = "PSA" | "BGS" | "CGC" | "SGC" | "TAG";

export interface InventoryRow {
  id: string;
  user_id: string;
  item_type: ItemType;
  card_id: string | null;
  product_id: string | null;
  grading_company: GradingCompany | null;
  grade: string | null;
  serial_number: string | null;
  is_sealed: boolean | null;
  purchase_price: number | null;
  purchase_date: string | null;
  notes: string | null;
  added_at: string;
  updated_at: string;
  // Joined
  card?: {
    id: string;
    name: string;
    number: string;
    rarity: string | null;
    set_id: string;
    image_small: string | null;
    image_large: string | null;
    sets?: { id: string; name: string };
  } | null;
  product?: {
    id: string;
    name: string;
    product_type: string;
    set_id: string;
    image_url: string | null;
  } | null;
  // Price cache joins
  cached_card_prices?: Array<{
    source: string;
    variant: string | null;
    grade: string | null;
    prices: Record<string, number>;
    expires_at: string;
  }>;
  product_price_cache?: Array<{
    source: string;
    market_price: number | null;
  }>;
}

export interface CreateInventoryInput {
  itemType: ItemType;
  cardId?: string | null;
  productId?: string | null;
  gradingCompany?: GradingCompany | null;
  grade?: string | null;
  serialNumber?: string | null;
  isSealed?: boolean | null;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  notes?: string | null;
}

export interface UpdateInventoryInput {
  gradingCompany?: GradingCompany | null;
  grade?: string | null;
  serialNumber?: string | null;
  isSealed?: boolean | null;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  notes?: string | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const INVENTORY_SELECT = `
  *,
  card:cards (
    id, name, number, rarity, set_id, image_small, image_large,
    sets ( id, name )
  ),
  product:products (
    id, name, product_type, set_id, image_url
  )
`;

// ─── Queries ──────────────────────────────────────────────────────────────────

export const findInventoryByUser = async (
  userId: string,
): Promise<InventoryRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select(INVENTORY_SELECT)
    .eq("user_id", userId)
    .order("added_at", { ascending: false });

  if (error) {
    console.error("[InventoryRepo] findByUser error:", error);
    throw error;
  }
  return (data ?? []) as InventoryRow[];
};

export const findInventoryItemById = async (
  id: string,
): Promise<InventoryRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select(INVENTORY_SELECT)
    .eq("id", id)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data as InventoryRow | null;
};

export const insertInventoryItem = async (
  userId: string,
  input: CreateInventoryInput,
): Promise<InventoryRow> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .insert({
      user_id: userId,
      item_type: input.itemType,
      card_id: input.cardId ?? null,
      product_id: input.productId ?? null,
      grading_company: input.gradingCompany ?? null,
      grade: input.grade ?? null,
      serial_number: input.serialNumber ?? null,
      is_sealed: input.isSealed ?? null,
      purchase_price: input.purchasePrice ?? null,
      purchase_date: input.purchaseDate ?? null,
      notes: input.notes ?? null,
    })
    .select(INVENTORY_SELECT)
    .single();

  if (error) {
    console.error("[InventoryRepo] insert error:", error);
    throw error;
  }
  return data as InventoryRow;
};

export const updateInventoryItem = async (
  id: string,
  userId: string,
  input: UpdateInventoryInput,
): Promise<InventoryRow> => {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (input.gradingCompany !== undefined)
    updates.grading_company = input.gradingCompany;
  if (input.grade !== undefined) updates.grade = input.grade;
  if (input.serialNumber !== undefined)
    updates.serial_number = input.serialNumber;
  if (input.isSealed !== undefined) updates.is_sealed = input.isSealed;
  if (input.purchasePrice !== undefined)
    updates.purchase_price = input.purchasePrice;
  if (input.purchaseDate !== undefined)
    updates.purchase_date = input.purchaseDate;
  if (input.notes !== undefined) updates.notes = input.notes;

  const { data, error } = await supabaseAdmin
    .from("inventory")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .select(INVENTORY_SELECT)
    .single();

  if (error) {
    console.error("[InventoryRepo] update error:", error);
    throw error;
  }
  return data as InventoryRow;
};

export const deleteInventoryItem = async (
  id: string,
  userId: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("inventory")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    console.error("[InventoryRepo] delete error:", error);
    throw error;
  }
};

// Insert multiple items at once — used when opening a sealed product
export const insertInventoryBatch = async (
  userId: string,
  items: CreateInventoryInput[],
): Promise<void> => {
  const rows = items.map((input) => ({
    user_id: userId,
    item_type: input.itemType,
    card_id: input.cardId ?? null,
    product_id: null,
    grading_company: null,
    grade: null,
    serial_number: null,
    is_sealed: null,
    purchase_price: input.purchasePrice ?? null,
    purchase_date: input.purchaseDate ?? null,
    notes: input.notes ?? null,
  }));

  const { error } = await supabaseAdmin.from("inventory").insert(rows);

  if (error) {
    console.error("[InventoryRepo] batch insert error:", error);
    throw error;
  }
};

// Fetch cached card prices for a list of card IDs
export const fetchCardPrices = async (
  cardIds: string[],
): Promise<Map<string, Record<string, number>>> => {
  if (!cardIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("cached_card_prices")
    .select("card_id, source, variant, grade, prices")
    .in("card_id", cardIds)
    .gt("expires_at", new Date().toISOString());

  if (error) {
    console.error("[InventoryRepo] fetchCardPrices error:", error);
    return new Map();
  }

  // Build a map: cardId → best available market price
  const priceMap = new Map<string, Record<string, number>>();

  for (const row of data ?? []) {
    if (!priceMap.has(row.card_id)) {
      priceMap.set(row.card_id, {});
    }
    const entry = priceMap.get(row.card_id)!;
    const prices = row.prices as Record<string, number>;

    // Prefer TCGPlayer market price for raw, then CardMarket
    if (row.source === "tcgplayer" && !row.grade && prices.market) {
      entry.raw_market = prices.market;
    }
    if (row.source === "cardmarket" && !row.grade && prices.trend) {
      entry.cm_market = prices.trend;
    }

    // Graded prices — store per grade
    if (row.grade && prices.market) {
      const key = `${row.source}_${row.grade}`;
      entry[key] = prices.market;
    }
  }

  return priceMap;
};

// Fetch cached product prices for a list of product IDs
export const fetchProductPrices = async (
  productIds: string[],
): Promise<Map<string, number>> => {
  if (!productIds.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from("product_price_cache")
    .select("product_id, source, market_price")
    .in("product_id", productIds)
    .gt("expires_at", new Date().toISOString());

  if (error) {
    console.error("[InventoryRepo] fetchProductPrices error:", error);
    return new Map();
  }

  // Best price per product — prefer TCGPlayer, fallback to CardMarket/eBay
  const priceMap = new Map<string, number>();
  const priority = ["tcgplayer", "cardmarket", "ebay"];

  for (const source of priority) {
    for (const row of (data ?? []).filter((r) => r.source === source)) {
      if (!priceMap.has(row.product_id) && row.market_price) {
        priceMap.set(row.product_id, row.market_price);
      }
    }
  }

  return priceMap;
};

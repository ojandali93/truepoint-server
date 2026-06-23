import { supabaseAdmin } from "../lib/supabase";
import { fetchAllByIn } from "../lib/pgFetchAll";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ItemType = "raw_card" | "graded_card" | "sealed_product";
export type GradingCompany = "PSA" | "BGS" | "CGC" | "SGC" | "TAG";
export type CardCondition = "NM" | "LP" | "MP" | "HP" | "DM";
export type InventoryStatus = "active" | "sold" | "traded";

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
  variant_type: string | null; // ← new
  condition: CardCondition | null; // ← new
  quantity: number; // ← new
  manual_market_value: number | null;
  manual_market_value_source: string | null;
  collection_id: string | null;
  status: InventoryStatus;
  sold_price: number | null;
  sold_platform: string | null;
  sold_at: string | null;
  sold_notes: string | null;
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
  collection_id?: string | null;
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
  variantType?: string | null; // ← new
  condition?: CardCondition | null; // ← new
  quantity?: number;
}

export interface UpdateInventoryInput {
  gradingCompany?: GradingCompany | null;
  grade?: string | null;
  serialNumber?: string | null;
  isSealed?: boolean | null;
  purchasePrice?: number | null;
  purchaseDate?: string | null;
  notes?: string | null;
  variantType?: string | null; // ← new
  condition?: CardCondition | null; // ← new
  quantity?: number;
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

const variantKey = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

export const fetchVariantPrices = async (cardIds: string[]) => {
  const byVariant = new Map<string, number>(); // `${card_id}|${variantkey}` -> price
  const byCard = new Map<string, number>(); // card_id -> representative price
  if (cardIds.length === 0) return { byVariant, byCard };

  // Paginated — card_variants has multiple variant rows per card, so a large
  // "All collections" inventory easily exceeds PostgREST's 1000-row cap.
  const data = await fetchAllByIn<{
    card_id: string;
    variant_type: string | null;
    low_price: number | null;
    mid_price: number | null;
    high_price: number | null;
    market_price: number | null;
  }>({
    table: "card_variants",
    columns:
      "card_id, variant_type, low_price, mid_price, high_price, market_price",
    column: "card_id",
    ids: cardIds,
  });

  for (const r of data) {
    const price = r.market_price ?? r.mid_price ?? r.low_price;
    if (price == null) continue;
    byVariant.set(`${r.card_id}|${variantKey(r.variant_type)}`, Number(price));
    // representative: prefer "normal", else first seen
    const isNormal = variantKey(r.variant_type) === "normal";
    if (isNormal || !byCard.has(r.card_id))
      byCard.set(r.card_id, Number(price));
  }
  return { byVariant, byCard };
};

// ─── Queries ──────────────────────────────────────────────────────────────────

export const findInventoryByUser = async (
  userId: string,
  collectionId?: string | null,
): Promise<InventoryRow[]> => {
  let q = supabaseAdmin
    .from("inventory")
    .select(INVENTORY_SELECT)
    .eq("user_id", userId)
    .eq("status", "active"); // sold items drop out of active inventory + portfolio

  if (collectionId) {
    q = q.eq("collection_id", collectionId);
  }

  const { data, error } = await q.order("added_at", { ascending: false });

  if (error) {
    console.error("[InventoryRepo] findByUser error:", error);
    throw error;
  }
  return (data ?? []) as InventoryRow[];
};

// All items the user has marked sold, newest sale first.
export const findSoldByUser = async (
  userId: string,
): Promise<InventoryRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select(INVENTORY_SELECT)
    .eq("user_id", userId)
    .eq("status", "sold")
    .order("sold_at", { ascending: false, nullsFirst: false });

  if (error) {
    console.error("[InventoryRepo] findSoldByUser error:", error);
    throw error;
  }
  return (data ?? []) as InventoryRow[];
};

// Mark an item sold (or, when status='active', revert a sale).
export const setInventorySoldStatus = async (
  id: string,
  userId: string,
  fields: {
    status: "active" | "sold";
    sold_price: number | null;
    sold_platform: string | null;
    sold_at: string | null;
    sold_notes: string | null;
  },
): Promise<InventoryRow> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId)
    .select(INVENTORY_SELECT)
    .single();

  if (error) {
    console.error("[InventoryRepo] setInventorySoldStatus error:", error);
    throw error;
  }
  return data as InventoryRow;
};

// Set only the status of an inventory item (active | sold | traded). Used by
// the trade flow to move give-side items out of active inventory and to revert
// them. Lighter than setInventorySoldStatus — touches no sale fields.
export const setInventoryStatus = async (
  id: string,
  userId: string,
  status: "active" | "sold" | "traded",
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("inventory")
    .update({ status, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    console.error("[InventoryRepo] setInventoryStatus error:", error);
    throw error;
  }
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
      variant_type: input.variantType ?? null,
      condition: input.condition ?? null,
      quantity: input.quantity ?? 1,
      collection_id: input.collection_id ?? null,
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
  if (input.variantType !== undefined) updates.variant_type = input.variantType; // ← new
  if (input.condition !== undefined) updates.condition = input.condition; // ← new
  if (input.quantity !== undefined) updates.quantity = input.quantity;

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
    condition: input.condition ?? null, // ← new
    quantity: input.quantity ?? 1, // ← new
    collection_id: input.collection_id ?? null,
  }));

  const { error } = await supabaseAdmin.from("inventory").insert(rows);

  if (error) {
    console.error("[InventoryRepo] batch insert error:", error);
    throw error;
  }
};

/** Flattened per-card prices for inventory.service resolveMarketValue */
export const fetchCardPrices = async (
  cardIds: string[],
): Promise<Map<string, Record<string, number>>> => {
  if (!cardIds.length) return new Map();

  // Paginated — market_prices has many source/grade rows per card (a single
  // graded card can have 30–60 rows), so the combined "All collections" set
  // blows past PostgREST's 1000-row cap and silently truncates. That is the
  // bug that made cards show a price inside their collection but "—" in All.
  let data: Array<{
    card_id: string;
    source: string;
    variant: string | null;
    grade: string | null;
    market_price: number | null;
  }>;
  try {
    data = await fetchAllByIn({
      table: "market_prices",
      columns: "card_id, source, variant, grade, market_price",
      column: "card_id",
      ids: cardIds,
    });
  } catch (error) {
    console.error("[InventoryRepo] fetchCardPrices error:", error);
    return new Map();
  }

  type RawCand = { variant: string | null; price: number };
  const tcgRawByCard = new Map<string, RawCand[]>();
  const cmRawByCard = new Map<string, number>();
  const gradedByCard = new Map<string, Record<string, number>>();

  const bestRawTcg = (cands: RawCand[]): number | undefined => {
    if (!cands.length) return undefined;
    const prefer = cands.find(
      (c) =>
        (c.variant === "normal" || c.variant === "unlimited") &&
        c.price != null,
    );
    if (prefer) return prefer.price;
    const any = cands.find((c) => c.price != null);
    return any?.price;
  };

  for (const row of data ?? []) {
    const cid = row.card_id as string;
    const mp = row.market_price;
    if (mp == null) continue;

    if (!row.grade) {
      if (row.source === "tcgplayer") {
        const list = tcgRawByCard.get(cid) ?? [];
        list.push({ variant: row.variant ?? null, price: mp });
        tcgRawByCard.set(cid, list);
      } else if (row.source === "cardmarket" && !cmRawByCard.has(cid)) {
        cmRawByCard.set(cid, mp);
      }
      continue;
    }

    const parts = String(row.grade).trim().split(/\s+/);
    if (parts.length < 2) continue;
    const flatKey = `${parts[0].toLowerCase()}_${parts.slice(1).join(" ")}`;
    const bucket = gradedByCard.get(cid) ?? {};
    const prev = bucket[flatKey];
    if (prev === undefined || mp > prev) bucket[flatKey] = mp;
    gradedByCard.set(cid, bucket);
  }

  const out = new Map<string, Record<string, number>>();
  for (const cid of cardIds) {
    const rec: Record<string, number> = {};
    const raw = bestRawTcg(tcgRawByCard.get(cid) ?? []);
    if (raw !== undefined) rec.raw_market = raw;
    const cm = cmRawByCard.get(cid);
    if (cm !== undefined) rec.cm_market = cm;
    const g = gradedByCard.get(cid);
    if (g) Object.assign(rec, g);
    if (Object.keys(rec).length) out.set(cid, rec);
  }

  return out;
};

// Fetch cached product prices for a list of product IDs
export const fetchProductPrices = async (
  productIds: string[],
): Promise<Map<string, number>> => {
  if (!productIds.length) return new Map();

  // Paginated for consistency/safety (products are few today, but this keeps
  // the function correct if a user ever holds many sealed products).
  let data: Array<{
    product_id: string;
    source: string;
    market_price: number | null;
  }>;
  try {
    data = await fetchAllByIn({
      table: "product_price_cache",
      columns: "product_id, source, market_price",
      column: "product_id",
      ids: productIds,
      modify: (q) => q.gt("expires_at", new Date().toISOString()),
    });
  } catch (error) {
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

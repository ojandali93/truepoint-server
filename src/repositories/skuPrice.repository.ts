// src/repositories/skuPrice.repository.ts
// Condition-aware price resolution for inventory items.
// Reads from sku_prices (joined to card_skus) and resolves the best price
// for each (card_id, variant_type, condition_code) combination.
//
// AVAILABILITY: reads do NOT filter by expires_at. sku_prices keeps one current
// row per tcgapis_sku_id (upserted in place), so the latest price is always
// readable even if stale. Freshness is handled by the nightly SKU sync; expiry
// no longer makes a price disappear (which used to blank out the portfolio).

import { fetchAllByIn } from "../lib/pgFetchAll";

export interface SkuPriceKey {
  cardId: string;
  variantType?: string | null; // internal variant key (e.g. "holofoil")
  conditionCode?: string | null; // "NM" | "LP" | ...
}

// One resolved SKU price candidate for a card (used by the inventory resolver)
export interface SkuPriceRow {
  variantType: string | null;
  conditionCode: string | null;
  language: string | null;
  marketPrice: number | null;
  lowPrice: number | null;
}

// Compare variant keys tolerant of casing/separators so inventory's snake_case
// ("reverse_holofoil") matches the catalog's camelCase ("reverseHolofoil").
const variantKey = (v: string | null | undefined): string =>
  (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const sameVariant = (
  a: string | null | undefined,
  b: string | null | undefined,
): boolean => {
  const ka = variantKey(a);
  return ka !== "" && ka === variantKey(b);
};

/**
 * Batch-resolve SKU market prices for a set of inventory items.
 * Returns a Map keyed by cardId → all SKU rows for that card; the caller applies
 * the fallback ladder in memory (see pickSkuPrice) without N queries.
 */
export const fetchSkuPriceRows = async (
  cardIds: string[],
): Promise<Map<string, SkuPriceRow[]>> => {
  const out = new Map<string, SkuPriceRow[]>();
  if (!cardIds.length) return out;

  // Join sku_prices → card_skus to get variant/condition with each price.
  // No expires_at gate — always return the latest cached price per SKU.
  // Paginated: sku_prices can hold many SKU rows per card, so a large
  // inventory would otherwise be truncated at PostgREST's 1000-row cap.
  let priceRows: Array<{
    tcgapis_sku_id: number;
    card_id: string;
    market_price: number | null;
    low_price: number | null;
  }>;
  try {
    priceRows = await fetchAllByIn({
      table: "sku_prices",
      columns: "tcgapis_sku_id, card_id, market_price, low_price",
      column: "card_id",
      ids: cardIds,
    });
  } catch (err) {
    console.error(
      "[SkuPriceRepo] price fetch error:",
      err instanceof Error ? err.message : err,
    );
    return out;
  }
  if (!priceRows.length) return out;

  const skuIds = priceRows.map((r) => r.tcgapis_sku_id);

  // Paginated for the same reason — skuIds can exceed 1000 across many cards.
  let catRows: Array<{
    tcgapis_sku_id: number;
    variant_type: string | null;
    condition_code: string | null;
    language: string | null;
  }>;
  try {
    catRows = await fetchAllByIn({
      table: "card_skus",
      columns: "tcgapis_sku_id, variant_type, condition_code, language",
      column: "tcgapis_sku_id",
      ids: skuIds,
    });
  } catch (err) {
    console.error(
      "[SkuPriceRepo] catalog fetch error:",
      err instanceof Error ? err.message : err,
    );
    return out;
  }

  const catBySku = new Map<number, (typeof catRows)[number]>();
  for (const c of catRows) catBySku.set(c.tcgapis_sku_id, c);

  for (const p of priceRows) {
    const cat = catBySku.get(p.tcgapis_sku_id);
    if (!cat) continue;
    const list = out.get(p.card_id) ?? [];
    list.push({
      variantType: cat.variant_type ?? null,
      conditionCode: cat.condition_code ?? null,
      language: cat.language ?? "English",
      marketPrice: p.market_price,
      lowPrice: p.low_price,
    });
    out.set(p.card_id, list);
  }

  return out;
};

/**
 * Given the rows for one card and a desired variant+condition, pick the best
 * price using the fallback ladder. English preferred. Variant comparison is
 * casing/separator tolerant (reverse_holofoil ↔ reverseHolofoil).
 */
export const pickSkuPrice = (
  rows: SkuPriceRow[] | undefined,
  variantType?: string | null,
  conditionCode?: string | null,
): { price: number | null; source: string | null } => {
  if (!rows?.length) return { price: null, source: null };

  const english = rows.filter((r) => (r.language ?? "English") === "English");
  const pool = english.length ? english : rows;

  const priceOf = (r: {
    marketPrice: number | null;
    lowPrice: number | null;
  }) => r.marketPrice ?? r.lowPrice ?? null;

  // 1. exact variant + condition
  if (variantType && conditionCode) {
    const exact = pool.find(
      (r) =>
        sameVariant(r.variantType, variantType) &&
        r.conditionCode === conditionCode &&
        priceOf(r) != null,
    );
    if (exact) return { price: priceOf(exact), source: "tcgplayer-sku" };
  }

  // 2. same variant, NM
  if (variantType) {
    const nm = pool.find(
      (r) =>
        sameVariant(r.variantType, variantType) &&
        r.conditionCode === "NM" &&
        priceOf(r) != null,
    );
    if (nm) return { price: priceOf(nm), source: "tcgplayer-sku (NM)" };

    // 3. any condition for that variant
    const anyCond = pool.find(
      (r) => sameVariant(r.variantType, variantType) && priceOf(r) != null,
    );
    if (anyCond)
      return { price: priceOf(anyCond), source: "tcgplayer-sku (variant)" };
  }

  // 4. NM of any variant
  const nmAny = pool.find(
    (r) => r.conditionCode === "NM" && priceOf(r) != null,
  );
  if (nmAny) return { price: priceOf(nmAny), source: "tcgplayer-sku (any NM)" };

  // 5. anything with a price
  const any = pool.find((r) => priceOf(r) != null);
  if (any) return { price: priceOf(any), source: "tcgplayer-sku (any)" };

  return { price: null, source: null };
};

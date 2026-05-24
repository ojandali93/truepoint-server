// src/repositories/skuPrice.repository.ts
// Condition-aware price resolution for inventory items.
// Reads from sku_prices (joined to card_skus) and resolves the best price
// for each (card_id, variant_type, condition_code) combination.

import { supabaseAdmin } from "../lib/supabase";

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

/**
 * Batch-resolve SKU market prices for a set of inventory items.
 * Returns a Map keyed by `${cardId}|${variantType}|${conditionCode}`.
 *
 * Resolution per item (handled by the caller via fallback ladder):
 *  1. exact (card + variant + condition)
 *  2. same variant, NM condition
 *  3. any SKU for that card+variant
 *  4. any SKU for that card
 * This function returns ALL sku rows for the requested cards so the caller
 * can apply the ladder in memory without N queries.
 */
export const fetchSkuPriceRows = async (
  cardIds: string[],
): Promise<Map<string, SkuPriceRow[]>> => {
  const out = new Map<string, SkuPriceRow[]>();
  if (!cardIds.length) return out;

  // Join sku_prices → card_skus to get variant/condition with each price.
  // Supabase: use the foreign relationship by querying card_skus and
  // embedding the latest price. We do two queries and merge by sku id.
  const nowIso = new Date().toISOString();

  const { data: priceRows, error: pErr } = await supabaseAdmin
    .from("sku_prices")
    .select("tcgapis_sku_id, card_id, market_price, low_price")
    .in("card_id", cardIds)
    .gt("expires_at", nowIso);

  if (pErr) {
    console.error("[SkuPriceRepo] price fetch error:", pErr.message);
    return out;
  }
  if (!priceRows?.length) return out;

  const skuIds = priceRows.map(
    (r: { tcgapis_sku_id: number }) => r.tcgapis_sku_id,
  );

  const { data: catRows, error: cErr } = await supabaseAdmin
    .from("card_skus")
    .select("tcgapis_sku_id, variant_type, condition_code, language")
    .in("tcgapis_sku_id", skuIds);

  if (cErr) {
    console.error("[SkuPriceRepo] catalog fetch error:", cErr.message);
    return out;
  }

  const catBySku = new Map<number, any>();
  for (const c of catRows ?? []) catBySku.set(c.tcgapis_sku_id, c);

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
 * price using the fallback ladder. English preferred.
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
        r.variantType === variantType &&
        r.conditionCode === conditionCode &&
        priceOf(r) != null,
    );
    if (exact) return { price: priceOf(exact), source: "tcgplayer-sku" };
  }

  // 2. same variant, NM
  if (variantType) {
    const nm = pool.find(
      (r) =>
        r.variantType === variantType &&
        r.conditionCode === "NM" &&
        priceOf(r) != null,
    );
    if (nm) return { price: priceOf(nm), source: "tcgplayer-sku (NM)" };

    // 3. any condition for that variant
    const anyCond = pool.find(
      (r) => r.variantType === variantType && priceOf(r) != null,
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

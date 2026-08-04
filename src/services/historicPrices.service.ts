// src/services/historicPrices.service.ts
//
// Card and product price history, sourced live from TCGAPIs'
// /historic-prices/:productId (Business+ tier — same tier this app already
// uses for sales-history) rather than solely from this app's own
// card_price_history table. TCGAPIs has generally been tracking longer than
// this app has existed, so their history is usually deeper and more
// complete. card_price_history stays as a fallback for cards specifically
// — if TCGAPIs comes back thin or the call fails, cards still have
// something to show. Products have no local fallback; nothing was ever
// snapshotted for them, so a thin/failed TCGAPIs response means an honest
// empty series, not an error.
//
// Both cards.id and products.id ARE the TCGPlayer product ID in this
// app's schema (native keyspace, see variantPriceSync.service.ts and
// productPriceSync.service.ts) — cards additionally mirrors it into the
// explicit tcgapis_product_id column; products does not, so products.id
// itself is parsed directly.

import { supabaseAdmin } from "../lib/supabase";
import { tcgapisGet } from "../lib/tcgapisClient";

export type PriceHistoryRange = "7d" | "30d" | "90d";

export interface PriceHistoryPoint {
  date: string; // YYYY-MM-DD
  price: number;
}
export interface PriceHistorySeries {
  variant: string;
  points: PriceHistoryPoint[];
}
export interface PriceHistoryResult {
  range: PriceHistoryRange;
  series: PriceHistorySeries[];
  /** True when series is just today's current price as a single point,
   * not real historical trend data — neither TCGAPIs nor the local
   * snapshot table had anything. The UI should say so rather than
   * implying a trend from one dot. */
  isFallbackToCurrentPrice?: boolean;
}

const rangeDays = (range: PriceHistoryRange): number =>
  range === "30d" ? 30 : range === "90d" ? 90 : 7;

interface TCGHistoricPricesResponse {
  success: boolean;
  data?: {
    productId: number;
    createdAt?: string;
    // Keyed by date (YYYY-MM-DD), then by variant (Normal/Foil/...).
    prices?: Record<string, Record<string, { marketPrice?: number | null }>>;
  };
}

/**
 * Calls TCGAPIs live and reshapes the response into this app's existing
 * { variant, points } series shape. Returns null — not an empty array —
 * on any failure or if there's simply no prices object, so callers can
 * tell "nothing here" apart from "the call broke" in their own logs while
 * still falling through to the same place either way.
 */
const fetchFromTcgapis = async (
  productId: number,
  range: PriceHistoryRange,
): Promise<PriceHistorySeries[] | null> => {
  try {
    const res = await tcgapisGet<TCGHistoricPricesResponse>(
      `/api/v2/historic-prices/${productId}`,
    );
    const pricesByDate = res.data?.prices;
    if (!pricesByDate) return null;

    const since = new Date();
    since.setUTCDate(since.getUTCDate() - rangeDays(range));
    const sinceStr = since.toISOString().slice(0, 10);

    const byVariant = new Map<string, PriceHistoryPoint[]>();
    for (const [date, variants] of Object.entries(pricesByDate)) {
      if (date < sinceStr) continue;
      for (const [variant, priceData] of Object.entries(variants ?? {})) {
        const price = priceData?.marketPrice;
        if (price == null || !isFinite(price) || price <= 0) continue;
        const arr = byVariant.get(variant) ?? [];
        arr.push({ date, price });
        byVariant.set(variant, arr);
      }
    }

    if (byVariant.size === 0) return null;

    return Array.from(byVariant.entries()).map(([variant, points]) => ({
      variant,
      points: points.sort((a, b) => (a.date < b.date ? -1 : 1)),
    }));
  } catch (err) {
    console.warn(
      `[historicPrices] TCGAPIs call failed for product ${productId}:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

/** Reads card_price_history directly — the exact query the old controller
 * handler used, kept as-is so fallback behavior for existing users doesn't
 * change shape even though it's no longer the primary path. */
const fetchFromCardHistoryTable = async (
  cardId: string,
  range: PriceHistoryRange,
): Promise<PriceHistorySeries[]> => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - rangeDays(range));
  const sinceStr = since.toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from("card_price_history")
    .select("snapshot_date, variant, market_price")
    .eq("card_id", cardId)
    .eq("source", "tcgplayer")
    .is("grade", null)
    .gte("snapshot_date", sinceStr)
    .order("snapshot_date", { ascending: true });
  if (error) throw error;

  const byVariant = new Map<string, PriceHistoryPoint[]>();
  for (const row of data ?? []) {
    const v = (row as { variant: string | null }).variant ?? "normal";
    const price = Number((row as { market_price: unknown }).market_price);
    if (!isFinite(price) || price <= 0) continue;
    const arr = byVariant.get(v) ?? [];
    arr.push({
      date: String((row as { snapshot_date: unknown }).snapshot_date),
      price,
    });
    byVariant.set(v, arr);
  }

  return Array.from(byVariant.entries()).map(([variant, points]) => ({
    variant,
    points,
  }));
};

/**
 * Last resort when there's no real trend anywhere: use whatever price is
 * CURRENTLY cached in market_prices as a single, today-dated point, so the
 * chart shows something concrete on day one instead of "not enough
 * history yet." gradeKey null = raw card; otherwise "{company} {grade}"
 * (e.g. "PSA 10"), matching the string format market_prices.grade uses
 * everywhere else in this app.
 */
const fetchCurrentPriceAsFallback = async (
  cardId: string,
  gradeKey: string | null,
): Promise<PriceHistorySeries[] | null> => {
  let query = supabaseAdmin
    .from("market_prices")
    .select("variant, market_price")
    .eq("card_id", cardId);
  query = gradeKey
    ? query.eq("grade", gradeKey).eq("source", "poketrace")
    : query.is("grade", null);

  const { data, error } = await query;
  if (error || !data?.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const byVariant = new Map<string, PriceHistoryPoint[]>();
  for (const row of data) {
    const price = Number((row as { market_price: unknown }).market_price);
    if (!isFinite(price) || price <= 0) continue;
    const v =
      (row as { variant: string | null }).variant ?? gradeKey ?? "normal";
    if (byVariant.has(v)) continue; // one point per variant is enough here
    byVariant.set(v, [{ date: today, price }]);
  }
  if (byVariant.size === 0) return null;

  return Array.from(byVariant.entries()).map(([variant, points]) => ({
    variant,
    points,
  }));
};

/**
 * Card price history — card_price_history first, today's current price
 * as a last-resort single point second. TCGAPIs' /historic-prices was the
 * original primary source, but coverage turned out too thin in practice —
 * empty far more often than useful. card_price_history is fully within
 * this app's own control and keeps accumulating daily regardless of what
 * TCGAPIs does or doesn't have, so it's the more consistent source right
 * now. tcgapisProductId is kept as a parameter (unused below) rather than
 * removed from the signature, so re-adding a TCGAPIs tier later — once its
 * coverage is trustworthy — doesn't require touching every call site
 * again.
 */
export const getCardPriceHistory = async (
  cardId: string,
  _tcgapisProductId: number | null,
  range: PriceHistoryRange,
): Promise<PriceHistoryResult> => {
  const historySeries = await fetchFromCardHistoryTable(cardId, range);
  if (historySeries.length > 0) return { range, series: historySeries };

  const fallback = await fetchCurrentPriceAsFallback(cardId, null);
  return {
    range,
    series: fallback ?? [],
    isFallbackToCurrentPrice: !!fallback,
  };
};

/**
 * Graded card price history — DB-only, no TCGAPIs tier. TCGAPIs is a
 * TCGPlayer/raw-singles data source; it has no concept of graded cards at
 * all, so there's nothing to call live here. Reads card_price_history
 * directly, filtered to one company+grade — the daily snapshot job
 * (cardPriceHistory.service.ts) has been writing grade-inclusive rows all
 * along, so real history may already exist even though nothing was ever
 * built to read it back out until now. Falls back to today's current
 * graded price as a single point, same as the raw path, if there's
 * nothing yet.
 */
export const getGradedCardPriceHistory = async (
  cardId: string,
  company: string,
  grade: string,
  range: PriceHistoryRange,
): Promise<PriceHistoryResult> => {
  const gradeKey = `${company} ${grade}`;
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - rangeDays(range));
  const sinceStr = since.toISOString().slice(0, 10);

  const { data, error } = await supabaseAdmin
    .from("card_price_history")
    .select("snapshot_date, market_price")
    .eq("card_id", cardId)
    .eq("source", "poketrace")
    .eq("grade", gradeKey)
    .gte("snapshot_date", sinceStr)
    .order("snapshot_date", { ascending: true });
  if (error) throw error;

  const points: PriceHistoryPoint[] = [];
  for (const row of data ?? []) {
    const price = Number((row as { market_price: unknown }).market_price);
    if (!isFinite(price) || price <= 0) continue;
    points.push({
      date: String((row as { snapshot_date: unknown }).snapshot_date),
      price,
    });
  }

  if (points.length > 0) {
    return { range, series: [{ variant: gradeKey, points }] };
  }

  const fallback = await fetchCurrentPriceAsFallback(cardId, gradeKey);
  return {
    range,
    series: fallback ?? [],
    isFallbackToCurrentPrice: !!fallback,
  };
};

/** Product price history — TCGAPIs only. No local fallback exists yet
 * since nothing was ever snapshotted for products; a thin/failed TCGAPIs
 * response is an honest empty series, not an error. */
export const getProductPriceHistory = async (
  productId: string,
  range: PriceHistoryRange,
): Promise<PriceHistoryResult> => {
  const numericId = Number(productId);
  if (!isFinite(numericId)) return { range, series: [] };
  const series = await fetchFromTcgapis(numericId, range);
  return { range, series: series ?? [] };
};

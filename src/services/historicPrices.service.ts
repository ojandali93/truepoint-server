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

/** Card price history — TCGAPIs first, card_price_history as fallback. */
export const getCardPriceHistory = async (
  cardId: string,
  tcgapisProductId: number | null,
  range: PriceHistoryRange,
): Promise<PriceHistoryResult> => {
  if (tcgapisProductId != null) {
    const series = await fetchFromTcgapis(tcgapisProductId, range);
    if (series) return { range, series };
  }
  const series = await fetchFromCardHistoryTable(cardId, range);
  return { range, series };
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

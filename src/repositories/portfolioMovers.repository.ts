// src/repositories/portfolioMovers.repository.ts
//
// Raw reads for portfolio change attribution (see portfolioMovers.service.ts
// for the algorithm). Historical prices come from card_price_history, the
// daily snapshot table written by cardPriceHistory.service.ts — same table
// used by priceMoversDigest.service.ts and historicPrices.service.ts.
//
// card_price_history can fan out the same way market_prices does (a single
// graded card can have 30-60 rows — see fetchCardPrices' comment in
// inventory.repository.ts), so this uses the same chunked fetchAllByIn
// pattern rather than a plain .in() call.

import { fetchAllByIn } from "../lib/pgFetchAll";

export interface HistoricalPriceRow {
  card_id: string;
  source: string; // "tcgplayer" (raw) | "poketrace" (graded)
  variant: string | null; // raw only; null for graded rows
  grade: string | null; // graded only, "PSA 10" form; null for raw rows
  market_price: number;
  snapshot_date: string; // YYYY-MM-DD
}

/**
 * All card_price_history rows for the given cards within [sinceDate,
 * throughDate] (inclusive, YYYY-MM-DD). The caller reduces this down to
 * "closest row at-or-before a target date" per (card_id, source, variant,
 * grade) — this function just gets every candidate row, chunked/paged so a
 * large card set doesn't silently truncate at PostgREST's 1000-row cap.
 */
export const fetchHistoricalPriceRows = async (
  cardIds: string[],
  sinceDate: string,
  throughDate: string,
): Promise<HistoricalPriceRow[]> => {
  if (cardIds.length === 0) return [];

  return fetchAllByIn<HistoricalPriceRow>({
    table: "card_price_history",
    columns: "card_id, source, variant, grade, market_price, snapshot_date",
    column: "card_id",
    ids: cardIds,
    modify: (q) => q.gte("snapshot_date", sinceDate).lte("snapshot_date", throughDate),
  });
};

// src/repositories/portfolioMovers.repository.ts
//
// Historical price reads for portfolio change attribution (see
// portfolioMovers.service.ts for the algorithm).
//
// PHASE 2 FINDING, fixed here: the first version of this file fetched a
// full date RANGE across every owned card via fetchAllByIn (the same
// chunked-.in() pattern inventory.repository.ts uses for market_prices) and
// reduced "closest at-or-before" client-side. That times out in practice —
// card_price_history has no retention/purge (recon-confirmed) and sits at
// ~17M rows with ~5-10+ rows written per card PER DAY (every source/variant/
// grade combo, not just graded cards), so even a single mid-size inventory
// (mid-300s cards) turns a "narrow" 10-day range into 30k+ candidate rows —
// and deep OFFSET pagination over that many rows degrades badly regardless
// of ordering. fetchAllByIn's default orderColumn ("id", unrelated to this
// query's filter/sort columns) made it far worse (a pathological plan that
// timed out almost immediately), but even ordering correctly on the actual
// index-leading column (card_id) still stalls once total rows climb into
// the tens of thousands, because there's no way to ask PostgREST for "just
// the latest row per group" (Postgres's DISTINCT ON) without a database
// function — a schema change, out of scope for an application-layer fix.
//
// The fix: don't fetch a range and reduce client-side at all. Fetch, PER
// CARD, only the most recent rows at-or-before the target date (LIMIT
// bounded well above the observed per-card-per-day row ceiling — see
// HISTORY_ROWS_PER_CARD_CAP), batched in small parallel groups. This uses
// the SAME index (card_id is its leading column) but asks for a few dozen
// rows per query instead of tens of thousands total, and needs no OFFSET
// pagination at all. Confirmed empirically: a 301-card inventory resolves
// in ~5s this way, vs. timing out (>60s, never completing) with the range
// approach — see the Phase 2 report for the full before/after numbers.

import { supabaseAdmin } from "../lib/supabase";

export interface HistoricalPriceRow {
  card_id: string;
  source: string; // "tcgplayer" (raw) | "poketrace" (graded)
  variant: string | null; // raw only; null for graded rows
  grade: string | null; // graded only, "PSA 10" form; null for raw rows
  market_price: number;
  snapshot_date: string; // YYYY-MM-DD
}

// Comfortable headroom over the documented ceiling ("a single graded card
// can have 30-60 rows" — inventory.repository.ts's fetchCardPrices comment)
// for how many source/variant/grade rows one card can have on its single
// most recent qualifying date.
const HISTORY_ROWS_PER_CARD_CAP = 100;

// How many per-card lookups to run concurrently. Matches the batching
// convention already established for outbound calls in this codebase (see
// poketracePriceSync.service.ts's BATCH_SIZE) — these are local Postgres
// reads, not a rate-limited third party, so no inter-batch delay is needed,
// just a concurrency cap so a large inventory doesn't open hundreds of
// simultaneous connections at once.
const FETCH_CONCURRENCY = 20;

/**
 * For one card: every card_price_history row on its single most recent
 * snapshot_date that is <= atOrBeforeDate and >= lookbackStartDate (the
 * grace bound). May span more than one date if the limit is hit before
 * reaching a full day's rows, but callers only ever use the max date among
 * what's returned (see closestAtOrBefore in portfolioMovers.service.ts), so
 * over-fetching a little from older dates is harmless — under-fetching the
 * true latest date is the failure mode this guards against via the cap.
 */
const fetchLatestHistoricalPriceRowsForCard = async (
  cardId: string,
  atOrBeforeDate: string,
  lookbackStartDate: string,
): Promise<HistoricalPriceRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("card_price_history")
    .select("card_id, source, variant, grade, market_price, snapshot_date")
    .eq("card_id", cardId)
    .lte("snapshot_date", atOrBeforeDate)
    .gte("snapshot_date", lookbackStartDate)
    .order("snapshot_date", { ascending: false })
    .limit(HISTORY_ROWS_PER_CARD_CAP);

  if (error) throw error;
  return (data ?? []) as HistoricalPriceRow[];
};

/**
 * Same as above, batched across many cards with bounded concurrency. Errors
 * on any individual card are logged and treated as "no history for this
 * card" (an empty array) rather than failing the whole request — a
 * transient failure on one of a few hundred cards shouldn't take down the
 * entire attribution response; that card just lands in the excluded bucket
 * with reason "no_history", which is the correct, honest outcome anyway.
 */
export const fetchHistoricalPriceRowsForCards = async (
  cardIds: string[],
  atOrBeforeDate: string,
  lookbackStartDate: string,
): Promise<HistoricalPriceRow[]> => {
  if (cardIds.length === 0) return [];

  const uniqueIds = [...new Set(cardIds)];
  const out: HistoricalPriceRow[] = [];

  for (let i = 0; i < uniqueIds.length; i += FETCH_CONCURRENCY) {
    const batch = uniqueIds.slice(i, i + FETCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((id) =>
        fetchLatestHistoricalPriceRowsForCard(id, atOrBeforeDate, lookbackStartDate),
      ),
    );
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.status === "fulfilled") {
        out.push(...r.value);
      } else {
        console.error(
          `[PortfolioMoversRepo] historical price lookup failed for card ${batch[j]}:`,
          r.reason?.message ?? r.reason,
        );
      }
    }
  }

  return out;
};

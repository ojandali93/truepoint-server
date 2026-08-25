-- 2026-08-25_card_price_history_latest_rpc_v2.sql
--
-- v2 of card_price_history_latest_at_or_before(), per the EXPLAIN evidence
-- gathered against v1 (see the Phase 2.5 report): v1's DISTINCT ON over the
-- FULL card_id array uses card_price_history_card_date (card_id,
-- snapshot_date DESC) to fetch candidates, then does one global
-- Incremental Sort + dedupe across every card at once. At 20 cards that's
-- 1842 fetched rows for 188 kept (9.8:1 -- the lookback window's day count,
-- not "intraday" duplicates; card_price_history's unique constraint already
-- forbids more than one row per (card_id,source,variant,grade,snapshot_date)
-- per day). Bloat is ruled out (0.088% dead tuples, confirmed via
-- pg_stat_user_tables). The cost is real per-row processing at scale --
-- extrapolated to 301 cards, that model lands at 8.7-10.2s of pure CPU work,
-- which is why the account times out against the confirmed 8s
-- statement_timeout (authenticator role) even fully cache-warm.
--
-- v2 restructures the SAME query as a LATERAL per-card join instead of one
-- global scan+sort+dedupe: for each input card_id, a correlated subquery
-- does its OWN small DISTINCT ON over just that card's rows in range. This
-- does NOT reduce the number of candidate rows Postgres has to examine (the
-- WHERE conditions are identical either way) -- what it changes is the
-- execution shape: 301 small, independent per-card sorts against
-- card_price_history_card_date (card_id, snapshot_date DESC) via a Nested
-- Loop, instead of one merged sort across the whole input set. Whether that
-- shape is actually faster in practice is exactly what the benchmark (not
-- this comment) is for -- see the Phase 2.5 benchmark report for the real
-- numbers before this is adopted.
--
-- IMPORTANT: this returns EVERY (source, variant, grade) combo's latest
-- qualifying row per card, not one row per card. "Top-1-per-card" describes
-- the LATERAL join shape (one lateral invocation per card), not the output
-- cardinality -- a graded card can and should still return all its grade
-- rows. Getting this wrong would silently drop graded/variant prices; the
-- Phase 2 regression harness (diffing priceThen/priceNow against the known
-- baseline) is what actually catches that if it's broken here.
--
-- Deliberately a NEW function (v2), not a REPLACE of v1's
-- card_price_history_latest_at_or_before. v1 is left completely untouched
-- so rollback, if v2 doesn't pass its benchmark gate, is simply "the
-- repository never gets pointed at v2" -- no function to undo.
--
-- Run manually in Supabase SQL editor. Not applied automatically.

CREATE OR REPLACE FUNCTION card_price_history_latest_at_or_before_v2(
  p_card_ids text[],
  p_at_or_before_date date,
  p_lookback_start_date date
)
RETURNS TABLE (
  card_id text,
  source text,
  variant text,
  grade text,
  market_price numeric,
  snapshot_date date
)
LANGUAGE sql
STABLE
AS $$
  SELECT sub.card_id, sub.source, sub.variant, sub.grade, sub.market_price, sub.snapshot_date
  FROM unnest(p_card_ids) AS ids(card_id)
  CROSS JOIN LATERAL (
    SELECT DISTINCT ON (cph.source, cph.variant, cph.grade)
      cph.card_id, cph.source, cph.variant, cph.grade, cph.market_price, cph.snapshot_date
    FROM card_price_history cph
    WHERE cph.card_id = ids.card_id
      AND cph.snapshot_date <= p_at_or_before_date
      AND cph.snapshot_date >= p_lookback_start_date
    ORDER BY cph.source, cph.variant, cph.grade, cph.snapshot_date DESC
  ) sub
  -- Explicit outer ORDER BY: a LATERAL join's output order isn't guaranteed
  -- stable across repeated calls without one, which would silently break
  -- safe .range()-based pagination on the caller side (v1 learned this the
  -- hard way — its stability came from an explicit ORDER BY too). This sort
  -- is cheap: it's over the already-deduplicated OUTPUT (e.g. ~188 rows for
  -- 20 cards), not the much larger candidate set the LATERAL already
  -- collapsed per card.
  ORDER BY sub.card_id, sub.source, sub.variant, sub.grade;
$$;

REVOKE ALL ON FUNCTION card_price_history_latest_at_or_before_v2(text[], date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION card_price_history_latest_at_or_before_v2(text[], date, date) TO service_role;

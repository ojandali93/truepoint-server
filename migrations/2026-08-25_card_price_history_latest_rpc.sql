-- 2026-08-25_card_price_history_latest_rpc.sql
--
-- Phase 2.5 of the portfolio movers attribution work
-- (src/services/portfolioMovers.service.ts).
--
-- Phase 2's harness found that the per-card lookup fallback (one REST call
-- per owned card) is correct but too slow for a dashboard card that loads
-- on every home-screen view: 313 REST calls / ~7-9s for the largest real
-- account (301 distinct cards). The bulk range-fetch it replaced timed out
-- outright (card_price_history has no retention, ~17M rows, ~5-10+ rows
-- written per card per day — see BACKLOG.md), so neither approach was
-- viable as-is for a live endpoint.
--
-- This function does the "closest row at-or-before a target date, per
-- (card_id, source, variant, grade)" reduction SERVER-SIDE via Postgres's
-- DISTINCT ON, instead of fetching every candidate row over the wire and
-- reducing in application code. One call (or one per id-chunk, for very
-- large inputs) replaces the one-call-per-card loop.
--
-- ORDER BY (card_id, source, variant, grade, snapshot_date DESC) matches
-- the existing unique index on card_price_history
-- (card_id, source, variant, grade, snapshot_date) column-for-column, so
-- this should plan as an efficient index-driven scan rather than a
-- sequential scan — verify with EXPLAIN ANALYZE after running this if the
-- observed speedup doesn't match expectations.
--
-- Run manually in Supabase SQL editor. Not applied automatically.

CREATE OR REPLACE FUNCTION card_price_history_latest_at_or_before(
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
  SELECT DISTINCT ON (card_id, source, variant, grade)
    card_id, source, variant, grade, market_price, snapshot_date
  FROM card_price_history
  WHERE card_id = ANY(p_card_ids)
    AND snapshot_date <= p_at_or_before_date
    AND snapshot_date >= p_lookback_start_date
  ORDER BY card_id, source, variant, grade, snapshot_date DESC;
$$;

-- Server calls this only via supabaseAdmin (the service-role key, which
-- bypasses RLS entirely) — never from a client with the anon/authenticated
-- key. This reads raw pricing history across ALL cards regardless of
-- ownership, so it's deliberately not exposed beyond service_role.
REVOKE ALL ON FUNCTION card_price_history_latest_at_or_before(text[], date, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION card_price_history_latest_at_or_before(text[], date, date) TO service_role;

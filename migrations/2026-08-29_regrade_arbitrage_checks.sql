-- 2026-08-29_regrade_arbitrage_checks.sql
--
-- Phase 1 of UX_OVERHAUL_PLAN.md §5, B2 (metering) — the real source table
-- for the regrade-arbitrage monthly cap. Today, MONTHLY_LIMITS in
-- plan.service.ts defines regrade_arbitrage_views for all three tiers, but
-- MONTHLY_SOURCES.regrade_arbitrage_views is null ("no source table yet —
-- would need a usage table... cap is informational") and no controller ever
-- calls checkMonthlyLimit for it — the limit is decorative, not enforced.
-- This table is that missing source.
--
-- Chosen over reusing the events table (migrations/2026-08-29_events.sql)
-- for exactly the reason events.ts's own header comment states: billing
-- enforcement must never depend on a client-batched, best-effort telemetry
-- write that could be dropped, delayed, or (from a compromised client)
-- spoofed. A dedicated table, written server-side and synchronously inside
-- GET /grading/arbitrage's controller (non-Pro requests only — Pro is
-- unlimited, no reason to log it), keeps the metering source authoritative
-- and matches this codebase's existing pattern: ai_grading_reports and
-- grading_submissions are each their own dedicated table too, not rows in a
-- shared generic log.
--
-- Deliberately minimal — (user_id, created_at) only, same shape
-- plan.service.ts's getMonthlyUsage() already expects for
-- ai_grading_reports/grading_submissions (COUNT rows WHERE user_id = ? AND
-- created_at >= month start). No card/inventory reference: the metered
-- unit here is "checked the arbitrage feed," not "checked this specific
-- card," and the existing MONTHLY_SOURCES/getMonthlyUsage helpers don't
-- need more than this to slot regrade_arbitrage_views in as a real,
-- enforced limit (wiring that read/write is the next gate, not this one).
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS regrade_arbitrage_checks (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Matches getMonthlyUsage()'s query shape exactly: COUNT() WHERE user_id = ?
-- AND created_at >= month start.
CREATE INDEX IF NOT EXISTS regrade_arbitrage_checks_user_created_idx
  ON regrade_arbitrage_checks (user_id, created_at DESC);

ALTER TABLE regrade_arbitrage_checks ENABLE ROW LEVEL SECURITY;

-- Server writes go through supabaseAdmin (service role, bypasses RLS) per
-- this repo's controller -> service -> repository pattern — nothing here
-- grants direct client write access (a client can't insert its own checks
-- and inflate/deflate its remaining count). This policy only covers the
-- case where a future client reads the table directly instead of through
-- /me/plan's usage summary — same rationale as every other *_select_own
-- policy in this codebase (import_jobs, product_feedback, events).
CREATE POLICY regrade_arbitrage_checks_select_own ON regrade_arbitrage_checks
  FOR SELECT
  USING (auth.uid() = user_id);

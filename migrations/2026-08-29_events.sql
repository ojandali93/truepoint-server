-- 2026-08-29_events.sql
--
-- Phase 1 of UX_OVERHAUL_PLAN.md §5 — usage + funnel instrumentation.
-- Zero event tracking existed before this (verified: no analytics SDK in
-- either package.json, no events table, admin/analytics-* screens are
-- point-in-time COUNT() rollups over profiles/subscriptions/inventory, not
-- a behavioral log). This is the from-scratch source of truth for the
-- funnel events in §1's goals table and the event list agreed in the
-- Phase 1 plan.
--
-- Event list v1 (CHECK-constrained, not a native enum — zero precedent for
-- native enums in this codebase, see migrations/2026-08-28_product_feedback.sql):
--   install_first_open, signup_started, signup_completed, first_card_added,
--   first_grading_viewed, import_completed, paywall_viewed, subscribe_started,
--   subscribe_completed, feature_used
--
-- user_id is nullable ONLY for the two events that can fire before an
-- account exists (install_first_open — literally pre-signup; signup_started —
-- fired the moment "Create account" is tapped, before Supabase signUp
-- returns a user). Every other event happens after account creation and
-- must carry a user_id — enforced by the CHECK constraint at the bottom
-- rather than left to client discipline.
--
-- properties is jsonb, not typed columns, because the per-event context
-- shape genuinely varies (paywall_viewed carries trigger_context — reusing
-- product_feedback.trigger_context's existing taxonomy/field name, not a
-- second one; feature_used carries {name}; others carry nothing). Same
-- reasoning product_feedback.trigger_context itself used for its own
-- free-text column: an evolving, app-owned shape, not a closed set worth a
-- CHECK.
--
-- platform allows 'web' alongside 'ios'/'android' to match the
-- product_feedback.platform precedent, even though only the mobile client
-- is wired to write here in Phase 1 — no reason to close off a web funnel
-- later (e.g. Stripe checkout's subscribe_started/completed) if this table
-- is the shared store.
--
-- Deliberately NOT the source of truth for any billing-enforcement count
-- (e.g. regrade arbitrage's monthly cap) — that's
-- migrations/2026-08-29_regrade_arbitrage_checks.sql, a dedicated table
-- written server-side and synchronously. This table is client-batched,
-- best-effort, fire-and-forget telemetry; billing enforcement must never
-- depend on a write that can be dropped, delayed, or (from a compromised
-- client) spoofed.
--
-- No GIN index on properties yet — no query pattern needs it in Phase 1
-- (funnel analysis groups by event/user/created_at, not by properties
-- content). Add one in a follow-up migration if that changes; don't
-- speculate now.
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES auth.users(id) ON DELETE CASCADE,

  event        text NOT NULL
                 CHECK (event IN (
                   'install_first_open',
                   'signup_started',
                   'signup_completed',
                   'first_card_added',
                   'first_grading_viewed',
                   'import_completed',
                   'paywall_viewed',
                   'subscribe_started',
                   'subscribe_completed',
                   'feature_used'
                 )),

  properties   jsonb NOT NULL DEFAULT '{}'::jsonb,

  app_version  text,
  platform     text CHECK (platform IN ('ios', 'android', 'web')),

  created_at   timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT events_user_id_required_except_pre_signup
    CHECK (user_id IS NOT NULL OR event IN ('install_first_open', 'signup_started'))
);

-- Per-user funnel queries ("has this user fired first_card_added yet?",
-- building a single user's timeline) and per-event cohort/aggregate queries
-- ("how many signup_completed in the last 7 days") are the two query shapes
-- Phase 1 actually needs.
CREATE INDEX IF NOT EXISTS events_user_event_created_idx
  ON events (user_id, event, created_at DESC);
CREATE INDEX IF NOT EXISTS events_event_created_idx
  ON events (event, created_at DESC);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- Server writes go through supabaseAdmin (service role, bypasses RLS) per
-- this repo's controller -> service -> repository pattern — nothing here
-- grants direct client write access (writes go through the batch endpoint,
-- validated and inserted server-side). This policy only covers the case
-- where a future client reads the table directly instead of through a
-- server API (e.g. a "your activity" surface) — same rationale as every
-- other *_select_own policy in this codebase (import_jobs, product_feedback,
-- feedback_prompt_state).
CREATE POLICY events_select_own ON events
  FOR SELECT
  USING (auth.uid() = user_id);

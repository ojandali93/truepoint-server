-- 2026-08-28_product_feedback.sql
--
-- Phase 2 of the in-app feedback system (FEEDBACK_DESIGN.md, accepted with
-- §0's corrections). Two new tables + two more subscriptions columns.
-- cancel_requested_at is NOT added here — it already exists as of
-- migrations/2026-08-28_subscriptions_cancel_requested_at.sql (the cancel-
-- status bug fix, shipped ahead of this migration). See FEEDBACK_DESIGN.md
-- §1.4's note.
--
-- Deliberately NOT the existing `feedback` table (support tickets,
-- free-text-primary, category-based) — this is rating/reason-primary with
-- free text secondary, a different shape and lifecycle. See
-- FEEDBACK_DESIGN.md §1.1.
--
-- Enums are CHECK constraints on text, not native CREATE TYPE ... ENUM —
-- zero precedent for native enums in this codebase (see §1.2).
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

-- ─── product_feedback ───────────────────────────────────────────────────────
-- One row per submitted rating or cancellation reason. A dismissed/skipped
-- prompt never inserts a row here — see feedback_prompt_state (Flow A) and
-- subscriptions.exit_feedback_prompted_at (Flow B) for that half.

CREATE TABLE IF NOT EXISTS product_feedback (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  feedback_type       text NOT NULL
                        CHECK (feedback_type IN ('periodic', 'cancellation')),

  -- One-tap satisfaction rating. Required for periodic, unused for cancellation.
  rating              smallint
                        CHECK (rating BETWEEN 1 AND 5),

  -- Only meaningful when feedback_type = 'cancellation'. Array, not a single
  -- value — Flow B2's reason sheet is multi-select on mobile.
  -- 'just_exploring' is trial-only (see was_trial below and the CHECK at the
  -- bottom) — the honest "I was just trying it out" answer that doesn't fit
  -- any paid-churn reason.
  cancellation_reasons text[]
                        CHECK (cancellation_reasons IS NULL OR cancellation_reasons <@ ARRAY[
                          'too_expensive',
                          'missing_feature',
                          'didnt_work_as_expected',
                          'not_using_enough',
                          'switched_to_another_app',
                          'just_exploring',
                          'other'
                        ]::text[]),

  -- Captured from subscriptions.was_trial_at_cancel at submit time (the
  -- value recorded when the cancellation happened, not reconstructed later —
  -- see the ALTER below). Only meaningful for feedback_type = 'cancellation'.
  was_trial           boolean,

  -- Optional and secondary for both flow types.
  free_text           text CHECK (char_length(free_text) <= 2000),

  -- What the user had just done to trigger this prompt (periodic) or which
  -- surface produced this row (cancellation). Free text, not a CHECK enum —
  -- deliberately: an evolving, app-owned taxonomy, unlike feedback_type/
  -- cancellation_reasons which are genuinely closed sets. Documented values:
  -- 'grading_report_viewed' (Flow A's only trigger), 'cancel_flow_b1' (web),
  -- 'store_cancel_detected_b2' (mobile).
  trigger_context     text NOT NULL,

  app_version         text,
  platform            text CHECK (platform IN ('ios', 'android', 'web')),

  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT product_feedback_periodic_has_rating
    CHECK (feedback_type <> 'periodic' OR rating IS NOT NULL),
  CONSTRAINT product_feedback_cancellation_has_content
    CHECK (feedback_type <> 'cancellation'
           OR (cancellation_reasons IS NOT NULL AND array_length(cancellation_reasons, 1) > 0)
           OR free_text IS NOT NULL),
  CONSTRAINT product_feedback_reasons_scoped_to_cancellation
    CHECK (cancellation_reasons IS NULL OR feedback_type = 'cancellation'),
  CONSTRAINT product_feedback_just_exploring_requires_trial
    CHECK (was_trial = true OR NOT ('just_exploring' = ANY(COALESCE(cancellation_reasons, ARRAY[]::text[]))))
);

CREATE INDEX IF NOT EXISTS product_feedback_user_created_idx
  ON product_feedback (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS product_feedback_type_created_idx
  ON product_feedback (feedback_type, created_at DESC);

ALTER TABLE product_feedback ENABLE ROW LEVEL SECURITY;

-- Server writes via supabaseAdmin bypass RLS (service role). This policy only
-- covers a hypothetical future direct client read.
CREATE POLICY product_feedback_select_own ON product_feedback
  FOR SELECT
  USING (auth.uid() = user_id);


-- ─── feedback_prompt_state ──────────────────────────────────────────────────
-- Per-user gating state for Flow A (periodic) ONLY. Flow B's dedupe lives on
-- `subscriptions` instead (below) — one-shot per cancellation event, not a
-- repeating cooldown.
--
-- last_asked_at (not last_prompted_at — matches the mobile client's naming)
-- rides GET /users/me's response (user.service.ts::getMyProfileWithFeedbackState)
-- so the eligibility check is zero new per-launch network calls; Flow A's
-- gating logic itself is evaluated client-side from this state, not a server
-- round-trip.

CREATE TABLE IF NOT EXISTS feedback_prompt_state (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

  last_asked_at     timestamptz,          -- last time a prompt was actually shown
  prompt_count      integer NOT NULL DEFAULT 0,   -- total times shown
  dismissed_count   integer NOT NULL DEFAULT 0,   -- shown, then dismissed w/o answering
  responded_at      timestamptz,          -- last time the user actually answered

  -- Set once dismissed_count reaches 2 (the hard, permanent cap).
  opted_out         boolean NOT NULL DEFAULT false,

  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE feedback_prompt_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY feedback_prompt_state_select_own ON feedback_prompt_state
  FOR SELECT
  USING (auth.uid() = user_id);


-- ─── subscriptions: two more columns for Flow B2 ────────────────────────────
-- cancel_requested_at already exists (2026-08-28_subscriptions_cancel_requested_at.sql).
--
-- was_trial_at_cancel: captured the instant cancel_requested_at is set —
-- Stripe's cancelSubscription() and the RevenueCat CANCELLATION handler both
-- already have the subscription's trial/active status right there at that
-- moment. Recorded then, not reconstructed later from history.
--
-- exit_feedback_prompted_at: stamped the instant Flow B2 is resolved
-- (submitted OR dismissed) for the CURRENT cancellation. A pending B2 ask is
-- exactly: cancel_requested_at IS NOT NULL AND exit_feedback_prompted_at IS
-- NULL. Both this and was_trial_at_cancel get reset to NULL alongside
-- cancel_requested_at on any reactivation/resubscribe (same "reset the whole
-- cancel-intent cluster" logic already in upsertSubscription/
-- upsertAppleSubscription) — so a future cancellation asks again from a
-- clean slate.

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS was_trial_at_cancel boolean,
  ADD COLUMN IF NOT EXISTS exit_feedback_prompted_at timestamptz;

-- 2026-09-02_affiliate_commission_system.sql
--
-- Phase 0 of AUDITS/affiliate-system-plan.md (approved 2026-09-02). Schema
-- only -- no application code in this migration. See the design doc for
-- the full rationale; this comment covers only what isn't obvious from the
-- column list.
--
-- Audit context (doc §0): the existing attribution path (profiles.affiliation
-- free text -> undocumented trigger trg_apply_affiliation -> profiles.
-- affiliation_id) has never once resolved to a real affiliate across the 6
-- codes ever entered, and zero commission/ledger tables exist today. This
-- migration adds the replacement, alongside the existing mechanism -- it does
-- not touch or drop anything live (register.tsx's free-text field, the
-- affiliates table's existing columns, or the trigger).
--
-- ============================================================================
-- referral_attributions -- doc §2.3. One durable row per user, written by a
-- server-side resolution function (Phase 1), not the DB trigger. Stores the
-- raw code even on a failed match, unlike profiles.affiliation today, so a
-- future real affiliate match ("REDDIT" turning out to be real) is
-- queryable instead of silently lost.
-- ============================================================================

CREATE TABLE IF NOT EXISTS referral_attributions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE REFERENCES profiles(id),
  affiliate_id      uuid REFERENCES affiliates(id),
  raw_code_entered  text,
  resolved          boolean NOT NULL DEFAULT false,
  source            text NOT NULL CHECK (
    source IN ('web_cookie', 'mobile_manual', 'web_manual', 'post_signup_grace')
  ),
  -- window_start is set at the referred user's FIRST PAYMENT event, not at
  -- signup or attribution time -- ruled 2026-09-02: a long trial must not
  -- eat into the affiliate's 12-month (or custom, per affiliates.
  -- commission_window_months) window. Both stay null until that payment
  -- happens; Phase 1's webhook handlers are the only writers of these two.
  window_start      timestamptz,
  window_end        timestamptz,
  attributed_at     timestamptz NOT NULL DEFAULT now()
);

-- A resolved row always points at a real affiliate; an unresolved row never
-- does -- catches a future write-path bug where the two drift apart.
ALTER TABLE referral_attributions
  ADD CONSTRAINT referral_attributions_resolved_consistency
  CHECK (
    (resolved = true AND affiliate_id IS NOT NULL) OR
    (resolved = false AND affiliate_id IS NULL)
  );

CREATE INDEX IF NOT EXISTS referral_attributions_affiliate_id_idx
  ON referral_attributions (affiliate_id)
  WHERE affiliate_id IS NOT NULL;

-- ============================================================================
-- affiliates -- new columns for the flat rate-per-referred-user model (doc
-- §1). Deliberately NOT repurposing the existing collector_rate/pro_rate
-- columns -- those are a different, tier-specific model (rate varies by the
-- referred user's plan) that this flat model supersedes, not renames.
-- collector_rate/pro_rate stay as dead columns; the 3 existing affiliate
-- rows never generated revenue under them (doc §0.3), so there is nothing
-- to migrate. Dropping them is a separate, later cleanup -- not this
-- migration's call to make.
-- ============================================================================

ALTER TABLE affiliates
  ADD COLUMN IF NOT EXISTS commission_rate numeric(5,4) NOT NULL DEFAULT 0.20,
  ADD COLUMN IF NOT EXISTS commission_window_months integer NOT NULL DEFAULT 12;

ALTER TABLE affiliates
  ADD CONSTRAINT affiliates_commission_rate_range
  CHECK (commission_rate >= 0 AND commission_rate <= 1);

ALTER TABLE affiliates
  ADD CONSTRAINT affiliates_commission_window_positive
  CHECK (commission_window_months > 0);

-- ============================================================================
-- commission_ledger -- doc §3.1. Append-only, tied to payment events (never
-- subscription rows), so refunds/plan changes/trial-to-paid all reconcile
-- without rewriting history. One row per payment (or refund/chargeback)
-- event; rate_applied is stored per-row, not looked up live from affiliates.
-- commission_rate, so a future rate change never rewrites what an affiliate
-- already earned.
-- ============================================================================

CREATE TABLE IF NOT EXISTS commission_ledger (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id        uuid NOT NULL REFERENCES affiliates(id),
  referred_user_id    uuid NOT NULL REFERENCES profiles(id),
  attribution_id      uuid NOT NULL REFERENCES referral_attributions(id),
  source_platform     text NOT NULL CHECK (source_platform IN ('stripe', 'revenuecat')),
  -- The Stripe invoice id / RC transaction id this row derives from --
  -- doc §3.1's idempotency guard (see the unique index below). A clawback
  -- row's payment_event_id is the REFUND/chargeback event's own id, distinct
  -- from the original payment's, so the unique constraint doesn't collide
  -- between an earning row and its later clawback.
  payment_event_id    text NOT NULL,
  payment_event_type  text NOT NULL,
  gross               numeric(12,2) NOT NULL,
  fees                numeric(12,2) NOT NULL,
  net                 numeric(12,2) NOT NULL,
  currency            text NOT NULL,
  -- Snapshot of affiliates.commission_rate at the time this row was written
  -- -- see header comment. commission_amount = net * rate_applied, computed
  -- application-side at write time (not a generated column) so a clawback
  -- row can carry a negative commission_amount without fighting a CHECK.
  rate_applied        numeric(5,4) NOT NULL,
  commission_amount   numeric(12,2) NOT NULL,
  is_clawback         boolean NOT NULL DEFAULT false,
  clawback_of         uuid REFERENCES commission_ledger(id),
  earned_at           timestamptz NOT NULL,
  -- 'YYYY-MM' -- the month this row counts toward for monthly-in-arrears
  -- payout (doc §3.3), derived from earned_at at write time.
  payout_period       text NOT NULL,
  status              text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'eligible', 'paid', 'clawed_back')
  ),
  created_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT commission_ledger_clawback_consistency CHECK (
    (is_clawback = true AND clawback_of IS NOT NULL) OR
    (is_clawback = false AND clawback_of IS NULL)
  )
);

-- Idempotency guard (doc §3.1) -- a webhook retry must not double-write a
-- ledger row for the same payment event.
CREATE UNIQUE INDEX IF NOT EXISTS commission_ledger_source_event_unique
  ON commission_ledger (source_platform, payment_event_id);

CREATE INDEX IF NOT EXISTS commission_ledger_affiliate_period_idx
  ON commission_ledger (affiliate_id, payout_period);

CREATE INDEX IF NOT EXISTS commission_ledger_referred_user_idx
  ON commission_ledger (referred_user_id);

-- Run manually in the Supabase SQL editor. Not applied automatically.

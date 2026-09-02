-- 2026-09-02_referral_program_phase0.sql
--
-- Phase 0 of AUDITS/referral-program-plan.md (approved 2026-09-02). Schema
-- only -- no application code in this migration (the resolver, qualification
-- hook, and entitlement-grant logic are Phase 1/2). Reuses
-- referral_attributions (affiliate-system-plan.md's Phase 0 table) rather
-- than duplicating it -- see this file's own §2 for why.
--
-- ============================================================================
-- referral_codes -- one personal code per user, generated lazily (design
-- doc §2.1). Separate table from `affiliates`, deliberately: affiliate
-- slugs are a small, admin-curated namespace; personal codes are randomly
-- generated and need their own collision-checked space. The resolver
-- (Phase 1) checks `affiliates.slug` first, then this table -- see the
-- design doc §2.2 for the exact precedence rule.
-- ============================================================================

CREATE TABLE IF NOT EXISTS referral_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL UNIQUE REFERENCES profiles(id),
  code        text NOT NULL UNIQUE,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ============================================================================
-- referral_attributions -- ALTER, not a new table. "The SAME row must serve
-- both programs" (your own instruction) -- an affiliate attribution and a
-- referral attribution are now two values of one attribution_type enum on
-- the existing table, not two parallel tables. Design doc §2.2's exact
-- precedence rule: affiliate_id set only when attribution_type='affiliate',
-- referrer_user_id set only when attribution_type='referral', both null
-- only when unresolved. The pre-existing UNIQUE(user_id) already gives
-- "one attribution per user, first one wins" for free -- nothing to add
-- for that part of the rule.
-- ============================================================================

ALTER TABLE referral_attributions
  ADD COLUMN IF NOT EXISTS attribution_type text CHECK (attribution_type IN ('affiliate', 'referral')),
  ADD COLUMN IF NOT EXISTS referrer_user_id uuid REFERENCES profiles(id);

ALTER TABLE referral_attributions
  ADD CONSTRAINT referral_attributions_type_consistency CHECK (
    (attribution_type = 'affiliate' AND affiliate_id IS NOT NULL AND referrer_user_id IS NULL) OR
    (attribution_type = 'referral' AND referrer_user_id IS NOT NULL AND affiliate_id IS NULL) OR
    (attribution_type IS NULL AND affiliate_id IS NULL AND referrer_user_id IS NULL)
  );

-- Backfill: every row written so far (Phase 0-2 of the affiliate program)
-- predates this column and is, by construction, an affiliate-type row
-- whenever it's resolved (the referral half of the resolver doesn't exist
-- yet). Safe, and matches the CHECK constraint above exactly.
UPDATE referral_attributions
  SET attribution_type = 'affiliate'
  WHERE resolved = true AND affiliate_id IS NOT NULL AND attribution_type IS NULL;

CREATE INDEX IF NOT EXISTS referral_attributions_referrer_user_id_idx
  ON referral_attributions (referrer_user_id)
  WHERE referrer_user_id IS NOT NULL;

-- ============================================================================
-- referral_rewards -- design doc §3.1. Mirrors commission_ledger's own
-- shape: a row's status progresses in place (pending -> qualified ->
-- granted) via ordinary UPDATEs; a REVOCATION is always a new row
-- referencing the original via revoked_of, never a mutation of it -- the
-- identical append-only-reversal pattern commission_ledger's clawback
-- design already uses.
-- ============================================================================

CREATE TABLE IF NOT EXISTS referral_rewards (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id       uuid NOT NULL REFERENCES profiles(id),
  referred_user_id       uuid NOT NULL REFERENCES profiles(id),
  -- One reward row per referral relationship -- UNIQUE, not just an FK.
  -- Revocation rows (is_revocation=true) are the one exception: they
  -- reference the SAME attribution via revoked_of -> the original reward
  -- row, not via a second row on this column, so the UNIQUE constraint
  -- below is scoped to non-revocation rows only.
  attribution_id         uuid NOT NULL REFERENCES referral_attributions(id),
  status                 text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'qualified', 'granted', 'revoked', 'expired')
  ),
  qualifying_event_type  text CHECK (qualifying_event_type IN ('ai_grading_report')),
  qualifying_event_id    uuid,
  qualified_at           timestamptz,
  reward_type            text NOT NULL DEFAULT 'pro_month' CHECK (reward_type IN ('pro_month')),
  -- Which comp-row grant (subscriptions.id) this created or extended.
  -- Nullable until granted; no FK constraint deliberately -- see
  -- commission_ledger's own admin_flagged_reports-style precedent
  -- (affiliate-system-plan.md §3.1 does the analogous thing for a
  -- different reason) -- here the reason is simpler: a subscriptions row
  -- can be reused/extended by a LATER reward too (design doc §4's
  -- stacking behavior), so this points at "the row this grant most
  -- recently touched," not an exclusively-owned child.
  comp_subscription_id   uuid,
  granted_period_start   timestamptz,
  granted_period_end     timestamptz,
  granted_at             timestamptz,
  is_revocation          boolean NOT NULL DEFAULT false,
  revoked_of             uuid REFERENCES referral_rewards(id),
  revoked_reason         text,
  created_at             timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT referral_rewards_revocation_consistency CHECK (
    (is_revocation = true AND revoked_of IS NOT NULL) OR
    (is_revocation = false AND revoked_of IS NULL)
  )
);

-- Enforces "one reward row per referral relationship" for the primary
-- (non-revocation) row only -- a partial unique index, since a revocation
-- is deliberately a SECOND row against the same attribution.
CREATE UNIQUE INDEX IF NOT EXISTS referral_rewards_attribution_unique
  ON referral_rewards (attribution_id)
  WHERE is_revocation = false;

CREATE INDEX IF NOT EXISTS referral_rewards_referrer_status_idx
  ON referral_rewards (referrer_user_id, status);

CREATE INDEX IF NOT EXISTS referral_rewards_status_idx
  ON referral_rewards (status)
  WHERE status = 'qualified';  -- the grant-sweep's own working set (design doc §3.3)

-- ============================================================================
-- subscriptions.comp_reason -- Finding 1 (affiliate-system-plan.md's own
-- follow-through, referral-program-plan.md §0.2). Closes a real collision:
-- deactivateGrandfatherCompIfNoRealSubRemains cancels ANY platform='comp'
-- row unconditionally once a user's last real subscription ends, with no
-- way today to tell WHY a comp row exists. A referral-reward comp grant
-- would be silently, prematurely canceled by an unrelated real-subscription
-- lapse without this tag -- and, discovered while designing this, the
-- SAME exposure already existed for affiliate-claim and vendor-trial comp
-- rows before this program touched anything.
-- ============================================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS comp_reason text CHECK (
    comp_reason IN ('grandfather', 'affiliate_claim', 'vendor_trial', 'admin_grant', 'referral_reward', 'referral_welcome')
  );

-- Backfill every existing comp row, most-specific rule last so it wins.
-- 1) Generic default for any comp row not otherwise identified.
UPDATE subscriptions
  SET comp_reason = 'admin_grant'
  WHERE platform = 'comp' AND comp_reason IS NULL;

-- 2) Affiliate-claim comps: the user is a claimed affiliate (affiliates.user_id).
UPDATE subscriptions
  SET comp_reason = 'affiliate_claim'
  WHERE platform = 'comp'
    AND user_id IN (SELECT user_id FROM affiliates WHERE user_id IS NOT NULL);

-- 3) Vendor-trial comps: the user has a vendor_code_redemptions row.
UPDATE subscriptions
  SET comp_reason = 'vendor_trial'
  WHERE platform = 'comp'
    AND user_id IN (SELECT user_id FROM vendor_code_redemptions);

-- 4) The 4 rows from the 2026-08-29 "Phase 1 §7 grandfather" migration --
-- identified by exact id from activity_logs (action=
-- 'admin.user.plan_override', notes reading "Phase 1 §7 grandfather...
-- at migration time"), not by any heuristic. Most specific, applied last.
UPDATE subscriptions
  SET comp_reason = 'grandfather'
  WHERE id IN (
    'a5f559c2-4f43-4620-b6e7-b1d42427d412',
    '9a7f9352-b6a6-4d2a-97ad-d730a084f94a',
    'be9e8159-d4b0-48f8-b87e-0eed960e1aac',
    '8e958049-dbfe-4cc6-af57-06ba4680c51d'
  );

-- Run manually in the Supabase SQL editor. Not applied automatically.

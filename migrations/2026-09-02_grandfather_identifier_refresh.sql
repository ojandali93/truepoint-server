-- 2026-09-02_grandfather_identifier_refresh.sql
--
-- Repair for the 4 rows tagged comp_reason='grandfather' by the previous
-- migration (2026-09-02_referral_program_phase0.sql). Investigated and
-- reported, not silently fixed, before this migration was written -- see
-- that session's report for the full empirical evidence. Summary:
--
-- These 4 rows still carry the rc_app_user_id/provider_subscription_id
-- from when they were real 'apple' subscription rows, before the
-- 2026-08-29 "Phase 1 §7 grandfather" migration converted them to
-- platform='comp' in place. Confirmed empirically (a synthetic test
-- reproducing the exact state, run through the real
-- upsertRevenueCatSubscription): the next RevenueCat INITIAL_PURCHASE /
-- RENEWAL / UNCANCELLATION / PRODUCT_CHANGE event for any of these users
-- creates a SECOND row (its onConflict target is (user_id, platform),
-- which no longer matches since this row's platform now reads 'comp') --
-- not an update-in-place, a genuine duplicate, bounded at 2 rows (every
-- subsequent renewal correctly targets the new real row from then on).
--
-- resolvePlan()'s plan resolution is unaffected (confirmed: it's a max
-- across all active/trialing rows, not a sum -- two rows at equal rank
-- change nothing about the resolved plan).
--
-- The real risk is a DIFFERENT, non-platform-scoped write path:
-- updateRevenueCatSubscriptionStatus and setCancelRequestedAtByProviderId
-- (called for CANCELLATION/EXPIRATION/BILLING_ISSUE) match by
-- provider_subscription_id ALONE. Once the duplicate exists, that column
-- is no longer unique for this user -- a later cancellation/expiration
-- event would update BOTH rows in the same statement, incorrectly
-- canceling the grandfather grant as a side effect of the user's real
-- subscription's own real lifecycle event.
--
-- Fix: clear the stale identifiers on the 4 grandfather rows now, before
-- any of them renews. A permanent comp grant never needs
-- rc_app_user_id/provider_subscription_id -- grantCompPro's own permanent
-- affiliate-claim grants never set them either. Nothing is lost: the
-- original real-subscription context is independently preserved in
-- activity_logs (action='admin.user.plan_override', the "Phase 1 §7
-- grandfather... at migration time" notes), not only on this row.
--
-- Same 4 exact ids as the comp_reason backfill -- not a heuristic.
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

UPDATE subscriptions
  SET rc_app_user_id = NULL,
      provider_subscription_id = NULL,
      updated_at = now()
  WHERE id IN (
    'a5f559c2-4f43-4620-b6e7-b1d42427d412',
    '9a7f9352-b6a6-4d2a-97ad-d730a084f94a',
    'be9e8159-d4b0-48f8-b87e-0eed960e1aac',
    '8e958049-dbfe-4cc6-af57-06ba4680c51d'
  )
  AND comp_reason = 'grandfather'; -- belt-and-suspenders: refuses to touch anything that isn't tagged as expected

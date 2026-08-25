-- 2026-08-24_renewal_reminder_sent_for.sql
--
-- Adds the idempotency-stamp column used by the renewal-reminder email sweep
-- (src/services/renewalReminder.service.ts). Mirrors the pattern of
-- profiles.welcome_email_sent_at used by the intro-email sweep, but scoped
-- to a renewal CYCLE (the specific current_period_end value) rather than a
-- one-time flag, so the reminder re-arms automatically on the next cycle.
--
-- Run manually in Supabase SQL editor. Not applied automatically.

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS renewal_reminder_sent_for timestamptz;

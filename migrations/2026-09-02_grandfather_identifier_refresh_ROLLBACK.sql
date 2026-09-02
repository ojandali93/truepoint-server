-- 2026-09-02_grandfather_identifier_refresh_ROLLBACK.sql
--
-- Companion to 2026-09-02_grandfather_identifier_refresh.sql. Not part of
-- the forward migration -- a standing, ready-to-run restore, committed
-- BEFORE the forward migration is ever applied, precisely so this isn't
-- reversible-in-theory-via-Supabase-backups only. If clearing
-- rc_app_user_id/provider_subscription_id on the 4 grandfather rows turns
-- out to be wrong, run this file to put the exact original values back --
-- no backup restore, no guessing, the literal values these rows held
-- before 2026-09-02, captured directly from a live read at the time this
-- file was written.

UPDATE subscriptions SET rc_app_user_id = '2bee0d3f-b179-4bad-b58b-1f7d38e0789e', provider_subscription_id = '580002224199910' WHERE id = 'a5f559c2-4f43-4620-b6e7-b1d42427d412';
UPDATE subscriptions SET rc_app_user_id = 'e30c28bf-af1c-487b-8b62-ac963259b1cf', provider_subscription_id = '240002591034233' WHERE id = '9a7f9352-b6a6-4d2a-97ad-d730a084f94a';
UPDATE subscriptions SET rc_app_user_id = 'a912179a-0701-44b5-aa7d-c758758a3fa8', provider_subscription_id = '550003126099952' WHERE id = 'be9e8159-d4b0-48f8-b87e-0eed960e1aac';
UPDATE subscriptions SET rc_app_user_id = 'c857df72-8e3d-4cfa-b512-366c77fddcdc', provider_subscription_id = '490003029772763' WHERE id = '8e958049-dbfe-4cc6-af57-06ba4680c51d';

-- Verify after running:
-- SELECT id, rc_app_user_id, provider_subscription_id FROM subscriptions
--   WHERE comp_reason = 'grandfather';
-- All 4 should show non-null values matching the UPDATEs above.

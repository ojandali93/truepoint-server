-- 2026-08-26_import_jobs.sql
--
-- Persistent record for POST /api/v1/import/commit (docs/csv-import-design.md
-- Phase 3). Two things this table exists for that ephemeral UI state can't
-- provide (Omar's Phase 2 requirement B):
--
--   1. A user re-opening the app after an import session ends can still see
--      what did and didn't get imported — the review screen isn't the only
--      place this information lives.
--   2. Idempotency: (user_id, idempotency_key) is unique, so a retried
--      commit POST (duplicate network request, accidental double-tap) finds
--      the existing row and returns its result instead of writing the
--      inventory rows a second time.
--
-- not_imported is one JSONB array covering all three reasons a row didn't
-- land in inventory (unmatched, user-skipped, unsupported-category) with
-- its identifying fields — not three separate columns — because the
-- review UI renders them as one list ("we couldn't confirm or import
-- these — add them manually") and there's no query pattern that needs to
-- filter by reason at the SQL level; if that changes, promote reason to a
-- real column then.
--
-- Run manually in Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS import_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'csv',
  idempotency_key text NOT NULL,
  total_rows integer NOT NULL,
  imported_count integer NOT NULL DEFAULT 0,
  not_imported jsonb NOT NULL DEFAULT '[]'::jsonb,
  portfolio_value_at_import numeric,
  status text NOT NULL DEFAULT 'completed',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS import_jobs_user_id_created_at_idx
  ON import_jobs (user_id, created_at DESC);

ALTER TABLE import_jobs ENABLE ROW LEVEL SECURITY;

-- Server writes go through supabaseAdmin (service role, bypasses RLS) per
-- this repo's controller -> service -> repository pattern — nothing here
-- grants direct client write access. This policy only covers the case
-- where a future client reads the table directly instead of through the
-- server API.
CREATE POLICY import_jobs_select_own ON import_jobs
  FOR SELECT
  USING (auth.uid() = user_id);

-- 2026-09-01_counterfeit_screening_reports.sql
--
-- Counterfeit Screening, Phase 1 (AUDITS/counterfeit-screening-plan.md).
-- Storage for one screening report per submission — front/back/backlit
-- image URLs, the identified-card summary, and the per-property findings
-- array from analyzeCardForCounterfeits() (src/lib/geminiClient.ts).
--
-- Modeled directly on ai_grading_reports' shape and lifecycle: a row is
-- inserted with status='processing' the moment the request comes in (so
-- there's an id to return immediately), Gemini runs in the background
-- (setImmediate, no await — see counterfeitScreening.controller.ts), and
-- the row is updated to 'completed'/'failed' when that finishes. Same
-- reason: the model call takes long enough that the client can't sit on
-- an open HTTP connection waiting for it.
--
-- findings is jsonb, not typed columns — same reasoning as events.sql's
-- properties column: this is an array of 10 objects
-- ({property, finding_text, severity, confidence, reference_used}), an
-- app-owned evolving shape, not worth 50 columns or a second table.
--
-- top_line_result and concern_count are stored as their own columns
-- (not derived at read time from findings) because they're literally what
-- CounterfeitScreenResult computes and they're what every list/report view
-- reads directly — same "count in code, store the result" pattern
-- computeTpScore/mapTpScore already establish for ai_grading_reports
-- rather than re-deriving the top-line result from findings on every read.
--
-- match_confidence mirrors cardIdentification.service.ts's own
-- CardScanResult.matchConfidence union exactly (exact/probable/unverified/
-- failed) — reusing that vocabulary rather than inventing a second one.
--
-- Counted by plan.service.ts's MONTHLY_SOURCES for the
-- "counterfeit_screening_reports" MonthlyLimitKey (getMonthlyUsage does a
-- plain COUNT WHERE user_id = ... AND created_at >= month_start — this
-- table IS that source, same role ai_grading_reports plays for
-- ai_grading_reports the MonthlyLimitKey).
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS counterfeit_screening_reports (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status                text NOT NULL DEFAULT 'processing'
                          CHECK (status IN ('processing', 'completed', 'failed')),

  front_image           text,
  back_image            text,
  backlit_image          text,  -- null when the user skipped the backlit step

  -- Identified-card summary (see counterfeitScreening.service.ts's
  -- IdentifiedCardSummary) — nullable together; identification can fail
  -- outright, which is a normal, expected, non-error outcome here (the
  -- abstention design handles it), not something this table needs to
  -- reject.
  identified_card_name   text,
  identified_set_name    text,
  identified_card_number text,
  match_confidence       text CHECK (match_confidence IN ('exact', 'probable', 'unverified', 'failed')),
  reference_image_used   boolean NOT NULL DEFAULT false,

  backlit_included       boolean NOT NULL DEFAULT false,

  findings                jsonb NOT NULL DEFAULT '[]'::jsonb,
  overall_confidence      integer,
  concern_count            integer,
  top_line_result          text,
  notes                    text,

  failure_reason           text,  -- set when status='failed'; user-facing-safe message only

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS counterfeit_screening_reports_user_created_idx
  ON counterfeit_screening_reports (user_id, created_at DESC);

ALTER TABLE counterfeit_screening_reports ENABLE ROW LEVEL SECURITY;

-- Server writes go through supabaseAdmin (service role, bypasses RLS) —
-- same pattern as ai_grading_reports and every other *_select_own table in
-- this codebase. This policy only covers a future client reading the
-- table directly instead of through the server API.
CREATE POLICY counterfeit_screening_reports_select_own
  ON counterfeit_screening_reports
  FOR SELECT
  USING (auth.uid() = user_id);

-- 2026-09-04_grading_engine_comparisons.sql
--
-- Dual-engine grading comparison, Part A (AUDITS/dual-engine-grading-plan.md).
-- Sibling table to ai_grading_reports, one row per Ximilar card-grader call run
-- alongside our own Gemini pipeline — admin-only evaluation tool behind the
-- dual_engine_grading flag, not user-facing.
--
-- Modeled on counterfeit_screening_reports' shape (jsonb for the evolving
-- external-API payload, typed columns for what every read actually uses) and
-- lifecycle (row inserted at submit time so there's something to poll, updated
-- in place as the async job resolves).
--
-- Ximilar's card-grader endpoint is asynchronous-only (POST .../account/v2/request/
-- returns {id, status:"CREATED"}; poll GET .../account/v2/request/{id} until
-- status="DONE") — this row's own status column tracks OUR view of that job
-- (processing/completed/failed/timed_out), independent of ai_grading_reports'
-- own status, since the two engines complete at different times by design (the
-- comparison must never block or be blocked by our own report).
--
-- Live-probed 2026-09-04 against a real card (see plan doc §3): submitting
-- front+back together returns TWO per-side records (tagged Side: Front/Back,
-- not positional) with no combined/weighted `final` — gradeCard() computes that
-- itself (0.7*front + 0.3*back) before this table ever sees it. Ximilar's own
-- centering measurement (left/right, top/bottom ratio strings, plus raw pixel
-- margins) is the headline field here — a second independent geometric
-- measurement to set next to our own centering_ratio_front/back, not another
-- opinion.
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS grading_engine_comparisons (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_grading_report_id    uuid NOT NULL REFERENCES ai_grading_reports(id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  status                  text NOT NULL DEFAULT 'processing'
                            CHECK (status IN ('processing', 'completed', 'failed', 'timed_out')),

  ximilar_request_id      text,     -- Ximilar's own {id} from the submit call — lets a stuck job be looked up by hand against their dashboard
  ximilar_raw             jsonb,    -- full DONE response, unshaped — protects against schema drift; null until status='completed'

  -- Normalized once status='completed'. Kept as separate front/back objects
  -- (not pre-merged) so the comparison UI can show per-side detail, the same
  -- way ai_grading_reports itself keeps front/back distinct until the
  -- worst-face-cap collapses them.
  ximilar_front_grades    jsonb,    -- {centering, corners, edges, surface, final} for the Front-tagged record
  ximilar_back_grades     jsonb,    -- same shape, Back-tagged record
  ximilar_overall         numeric,  -- 0.7*front.final + 0.3*back.final, computed by gradeCard() — Ximilar never returns this itself

  -- Headline comparison field — kept distinct from ximilar_raw/ximilar_*_grades
  -- specifically so it's cheap to query/render without unpacking jsonb blobs.
  -- Shape: {front: {leftRight: "41/59", topBottom: "52/48"}, back: {...}} —
  -- Ximilar's own measured ratios, set next to ai_grading_reports.
  -- centering_ratio_front/back (our own measured ratios) in the UI.
  ximilar_centering_ratio jsonb,

  ximilar_latency_ms      integer,               -- submit-to-DONE (or submit-to-timeout) wall time, recorded on every outcome, not just success
  ximilar_credits         integer NOT NULL DEFAULT 100, -- flat cost per call — Ximilar's response has no credits/cost field to read instead (confirmed via docs + live probe)
  ximilar_error           text,                  -- failure or timeout reason; set together with status IN ('failed','timed_out')

  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS grading_engine_comparisons_report_idx
  ON grading_engine_comparisons (ai_grading_report_id);

CREATE INDEX IF NOT EXISTS grading_engine_comparisons_user_created_idx
  ON grading_engine_comparisons (user_id, created_at DESC);

ALTER TABLE grading_engine_comparisons ENABLE ROW LEVEL SECURITY;

-- Server writes go through supabaseAdmin (service role, bypasses RLS) — same
-- pattern as ai_grading_reports and counterfeit_screening_reports. This policy
-- only covers a future client reading the table directly instead of through
-- the server API.
CREATE POLICY grading_engine_comparisons_select_own
  ON grading_engine_comparisons
  FOR SELECT
  USING (auth.uid() = user_id);

-- Feature flag — admin-only, allowlist-of-one, mirrors pro_pricing_v2's shape
-- exactly. Created enabled with the real audience from day one (not
-- off + [NOT IMPLEMENTED]) since this row is only inserted once the code
-- exists — CLAUDE.md's unbuilt-feature convention doesn't apply here.
-- User id below verified live (auth.admin.getUserById), 2026-09-04:
-- 25e63b99-c664-430b-a48d-6ffa548b5818 -> omarjandali93@gmail.com, role admin
-- (same id already on pricecharting_pricing's own allowlist).
INSERT INTO feature_flags (key, enabled, audience, allowed_user_ids, description)
VALUES (
  'dual_engine_grading',
  true,
  'allowlist',
  ARRAY['25e63b99-c664-430b-a48d-6ffa548b5818']::uuid[],
  'Run Ximilar''s grading endpoint alongside Gemini and show a side-by-side comparison. Admin-only evaluation tool, not user-facing.'
)
ON CONFLICT (key) DO NOTHING;

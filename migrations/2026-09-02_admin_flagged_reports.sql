-- 2026-09-02_admin_flagged_reports.sql
--
-- Part B (admin user drill-down) — lets an admin flag a specific AI grading
-- or centering report as a golden-set candidate for the grading calibration
-- harness, from that report's own admin detail view.
--
-- report_type is a deliberate addition beyond the literal spec (which just
-- said "report_id, reason, flagged_at"): ai_grading_reports and
-- centering_reports are two separate tables with their own independent id
-- sequences, so a bare report_id is ambiguous -- two different reports
-- (one of each type) can share the same UUID by pure chance, and there is
-- nothing else in this table to disambiguate which table a given row's
-- report_id points into. Without it, a query joining back to the source
-- report has no reliable way to pick the right table.
--
-- No FK to ai_grading_reports/centering_reports: a single FK column can't
-- reference two different tables, and a CHECK-gated report_type is enough
-- to keep the two conceptually separate without a same-table FK dance
-- (a partial/conditional FK isn't natively expressible in Postgres without
-- triggers, which is more machinery than this needs). Integrity of
-- report_id pointing to something real is enforced application-side, at
-- the one write path (POST /admin/flagged-reports), not the DB.
--
-- flagged_by: which admin flagged it -- accountability, same reasoning as
-- every other admin-action table in this codebase recording an actor.
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS admin_flagged_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id uuid NOT NULL,
  report_type text NOT NULL CHECK (report_type IN ('ai_grading', 'centering')),
  reason text,
  flagged_by uuid REFERENCES profiles(id),
  flagged_at timestamptz NOT NULL DEFAULT now()
);

-- One admin flagging the same report twice should update, not duplicate --
-- the detail view reads "is this already flagged" by report_id+report_type.
CREATE UNIQUE INDEX IF NOT EXISTS admin_flagged_reports_report_unique
  ON admin_flagged_reports (report_id, report_type);

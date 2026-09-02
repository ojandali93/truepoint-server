-- 2026-09-02_affiliate_commission_payouts.sql
--
-- Phase 2 of AUDITS/affiliate-system-plan.md (§5, admin "mark paid" action).
-- Manual payouts only in v1 -- no Stripe Connect (doc §5/§6).
--
-- One row per payout event, recording exactly what the admin entered (date/
-- amount/method), plus a bidirectional link to which commission_ledger rows
-- it covers -- doc's own auditability bar ("I must be able to explain any
-- number to an affiliate line by line") requires this to be a real,
-- queryable record, not just a status flip with no memory of when/how an
-- affiliate was actually paid.
--
-- Not a full DB transaction across payout-creation + ledger-row-update (this
-- codebase's Supabase/PostgREST access has no multi-statement transaction
-- primitive in use elsewhere) -- the write path does insert-then-update in
-- two calls. A failure between them is recoverable by hand (the ledger's own
-- status/payout_id columns are the source of truth an admin can reconcile
-- against), not silently lost -- acceptable for a low-frequency, admin-only,
-- always-reviewed-before-confirming action.
--
-- Run manually in the Supabase SQL editor. Not applied automatically.

CREATE TABLE IF NOT EXISTS commission_payouts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  affiliate_id uuid NOT NULL REFERENCES affiliates(id),
  amount       numeric(12,2) NOT NULL,
  method       text NOT NULL, -- free text (PayPal/wire/check/...) per doc §5 -- manual payouts only, no processor integration
  paid_at      timestamptz NOT NULL,
  note         text,
  marked_by    uuid REFERENCES profiles(id), -- which admin recorded this -- accountability, same convention as admin_flagged_reports.flagged_by
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commission_payouts_affiliate_id_idx
  ON commission_payouts (affiliate_id);

-- Reverse pointer: which payout (if any) covered this ledger row. Set only
-- when a row's status flips to 'paid' -- null for every eligible/pending row.
ALTER TABLE commission_ledger
  ADD COLUMN IF NOT EXISTS payout_id uuid REFERENCES commission_payouts(id);

CREATE INDEX IF NOT EXISTS commission_ledger_payout_id_idx
  ON commission_ledger (payout_id)
  WHERE payout_id IS NOT NULL;

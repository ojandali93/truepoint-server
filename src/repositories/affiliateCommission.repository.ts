// affiliateCommission.repository.ts
//
// Data access for Phase 1 of AUDITS/affiliate-system-plan.md — the
// commission ledger and its referral_attributions link. Pure DB reads/
// writes, no business logic (rate application, window math, self-referral
// checks) — that lives in affiliateCommission.service.ts, same split as
// billing.repository.ts / billing.service.ts.

import { supabaseAdmin } from "../lib/supabase";

// ─── referral_attributions ─────────────────────────────────────────────────

export type ReferralAttributionRow = {
  id: string;
  user_id: string;
  affiliate_id: string | null;
  raw_code_entered: string | null;
  resolved: boolean;
  source: string;
  window_start: string | null;
  window_end: string | null;
  attributed_at: string;
};

export const findAttributionByUserId = async (
  userId: string,
): Promise<ReferralAttributionRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_attributions")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

/**
 * Sets window_start/window_end only if window_start is currently null —
 * the "first payment" anchor (doc §1, ruled 2026-09-02) must never move
 * once set. The `.is("window_start", null)` filter makes this atomic
 * set-once at the DB level: a race between two payment events for the same
 * brand-new attribution can't both win and overwrite each other.
 */
export const setAttributionWindowIfUnset = async (
  attributionId: string,
  windowStart: string,
  windowEnd: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("referral_attributions")
    .update({ window_start: windowStart, window_end: windowEnd })
    .eq("id", attributionId)
    .is("window_start", null);
  if (error) throw error;
};

// ─── affiliates (rate/window lookup only — full CRUD lives in affiliate.service.ts) ──

export type AffiliateRateInfo = {
  id: string;
  user_id: string | null;
  active: boolean;
  commission_rate: number;
  commission_window_months: number;
};

export const getAffiliateRateInfo = async (
  affiliateId: string,
): Promise<AffiliateRateInfo | null> => {
  const { data, error } = await supabaseAdmin
    .from("affiliates")
    .select("id, user_id, active, commission_rate, commission_window_months")
    .eq("id", affiliateId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

// ─── commission_ledger ──────────────────────────────────────────────────────

export type CommissionLedgerInsert = {
  affiliate_id: string;
  referred_user_id: string;
  attribution_id: string;
  source_platform: "stripe" | "revenuecat";
  payment_event_id: string;
  payment_event_type: string;
  gross: number;
  fees: number;
  net: number;
  currency: string;
  rate_applied: number;
  commission_amount: number;
  is_clawback: boolean;
  clawback_of: string | null;
  earned_at: string;
  payout_period: string;
  status: "pending" | "eligible";
};

export type CommissionLedgerRow = CommissionLedgerInsert & {
  id: string;
  created_at: string;
};

/**
 * Inserts one ledger row, relying on the (source_platform, payment_event_id)
 * unique index (migrations/2026-09-02_affiliate_commission_system.sql) for
 * idempotency. Returns null — not an error — when the insert collides with
 * an existing row: a webhook replay of an already-recorded payment event is
 * a no-op, exactly like every other webhook handler in this codebase
 * (billing.service.ts's updateSubscriptionStatus is naturally idempotent by
 * overwrite; this table is append-only, so idempotency has to be an
 * explicit constraint instead — this is that constraint's enforcement
 * point).
 */
export const insertLedgerRowIdempotent = async (
  row: CommissionLedgerInsert,
): Promise<CommissionLedgerRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("commission_ledger")
    .insert(row)
    .select("*")
    .single();
  if (error) {
    // 23505 = unique_violation — established convention in this codebase
    // (affiliate.controller.ts, adminPlatform.controller.ts, user.service.ts)
    // for "this Postgres error code means duplicate, not failure."
    if ((error as { code?: string }).code === "23505") return null;
    throw error;
  }
  return data as CommissionLedgerRow;
};

export const findLedgerRowByEvent = async (
  sourcePlatform: string,
  paymentEventId: string,
): Promise<CommissionLedgerRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("commission_ledger")
    .select("*")
    .eq("source_platform", sourcePlatform)
    .eq("payment_event_id", paymentEventId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

/**
 * RevenueCat's refund-via-CANCELLATION event carries no exact back-reference
 * to the specific transaction it refunds (verified against RC's current
 * webhook docs — no dedicated REFUND event, no confirmed transaction_id
 * linkage on a CUSTOMER_SUPPORT cancellation). RC's own docs DO confirm the
 * relevant constraint though: "this event fires only when the LATEST
 * subscription period is refunded; refunds for earlier periods do not
 * trigger it" — so "the most recent non-clawback earning row for this user
 * on this platform" isn't a guess, it's the row RC's own event model
 * guarantees is the one being refunded.
 */
export const findMostRecentEarningRowForUser = async (
  referredUserId: string,
  sourcePlatform: string,
): Promise<CommissionLedgerRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("commission_ledger")
    .select("*")
    .eq("referred_user_id", referredUserId)
    .eq("source_platform", sourcePlatform)
    .eq("is_clawback", false)
    .order("earned_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

/** Admin-surface read (Phase 2) — kept here now so Phase 1's validation
 * script has a way to read back what it wrote without reaching past the
 * repository layer. */
export const findLedgerRowsByAffiliateId = async (
  affiliateId: string,
): Promise<CommissionLedgerRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("commission_ledger")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .order("earned_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as CommissionLedgerRow[];
};

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

// Row type is NOT just CommissionLedgerInsert & {id, created_at}: a row can
// reach 'paid'/'clawed_back' via UPDATE (markLedgerRowsPaid, and a future
// clawback-status transition), states no INSERT ever writes directly — the
// insert type stays narrower on purpose (doc §3.1: inserts always start
// 'eligible' today, 'pending' reserved for a not-yet-cleared-payment case
// not yet wired). Also carries payout_id, set only once paid.
export type CommissionLedgerRow = Omit<CommissionLedgerInsert, "status"> & {
  id: string;
  created_at: string;
  status: "pending" | "eligible" | "paid" | "clawed_back";
  payout_id: string | null;
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

// ─── Phase 2: admin surface ─────────────────────────────────────────────────

/** Every referred user for an affiliate — the detail page's "referred
 * users" table (doc §5). Two-step fetch with profiles (CLAUDE.md §8's own
 * PostgREST pitfall note — no declared FK between referral_attributions
 * and profiles to embed on). */
export const listAttributionsByAffiliateId = async (
  affiliateId: string,
): Promise<ReferralAttributionRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("referral_attributions")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .order("attributed_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as ReferralAttributionRow[];
};

export type ProfileSummary = {
  id: string;
  username: string | null;
  full_name: string | null;
  created_at: string;
};

/** Same "id, username, full_name, created_at" shape as the existing admin
 * user-management reads (adminPlatform.service.ts) — matched deliberately,
 * not reinvented. */
export const findProfileSummariesByIds = async (
  userIds: string[],
): Promise<ProfileSummary[]> => {
  if (userIds.length === 0) return [];
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, full_name, created_at")
    .in("id", userIds);
  if (error) throw error;
  return (data ?? []) as ProfileSummary[];
};

export type CommissionPayoutInsert = {
  affiliate_id: string;
  amount: number;
  method: string;
  paid_at: string;
  note: string | null;
  marked_by: string | null;
};

export type CommissionPayoutRow = CommissionPayoutInsert & {
  id: string;
  created_at: string;
};

export const insertPayout = async (
  row: CommissionPayoutInsert,
): Promise<CommissionPayoutRow> => {
  const { data, error } = await supabaseAdmin
    .from("commission_payouts")
    .insert(row)
    .select("*")
    .single();
  if (error) throw error;
  return data as CommissionPayoutRow;
};

export const listPayoutsByAffiliateId = async (
  affiliateId: string,
): Promise<CommissionPayoutRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("commission_payouts")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .order("paid_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as CommissionPayoutRow[];
};

/** All rows this affiliate currently owes nothing further on — the exact
 * set the "mark paid" action will flip. Returns full rows (not just ids) so
 * the caller can compute/display the total being marked paid before
 * committing to the write below. */
export const findEligibleLedgerRowsByAffiliateId = async (
  affiliateId: string,
): Promise<CommissionLedgerRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("commission_ledger")
    .select("*")
    .eq("affiliate_id", affiliateId)
    .eq("status", "eligible")
    .order("earned_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as CommissionLedgerRow[];
};

/**
 * Flips exactly the given ledger rows to status='paid' with a payout_id
 * back-link. Scoped by an explicit id list (computed by the caller just
 * before this call, from findEligibleLedgerRowsByAffiliateId) rather than
 * re-filtering by status here, so what gets marked paid is exactly what the
 * admin was shown and confirmed — not whatever happens to still match
 * status='eligible' at write time.
 */
export const markLedgerRowsPaid = async (
  ledgerRowIds: string[],
  payoutId: string,
): Promise<void> => {
  if (ledgerRowIds.length === 0) return;
  const { error } = await supabaseAdmin
    .from("commission_ledger")
    .update({ status: "paid", payout_id: payoutId })
    .in("id", ledgerRowIds);
  if (error) throw error;
};

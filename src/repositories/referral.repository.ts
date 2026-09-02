// referral.repository.ts
//
// Data access for AUDITS/referral-program-plan.md's Phase 1/2 work: the
// shared code resolver, referral_codes, and referral_rewards. Pure reads/
// writes, no business logic (flag checks, precedence, grant math) — that
// lives in attribution.service.ts / referralReward.service.ts, same split
// as every other repository/service pair in this codebase.

import { supabaseAdmin } from "../lib/supabase";

// ─── affiliates lookup (resolver's first check) ────────────────────────────

export type AffiliateSlugMatch = {
  id: string;
  user_id: string | null;
  active: boolean;
};

export const findActiveAffiliateBySlug = async (
  normalizedSlug: string,
): Promise<AffiliateSlugMatch | null> => {
  const { data, error } = await supabaseAdmin
    .from("affiliates")
    .select("id, user_id, active")
    .ilike("slug", normalizedSlug)
    .eq("active", true)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

// ─── referral_codes ─────────────────────────────────────────────────────────

export type ReferralCodeRow = {
  id: string;
  user_id: string;
  code: string;
  created_at: string;
};

export const findReferralCodeByUserId = async (
  userId: string,
): Promise<ReferralCodeRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_codes")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

export const findReferralCodeByCode = async (
  normalizedCode: string,
): Promise<ReferralCodeRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_codes")
    .select("*")
    .ilike("code", normalizedCode)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

/** Returns null on a code collision — caller retries with a new draw. */
export const insertReferralCode = async (
  userId: string,
  code: string,
): Promise<ReferralCodeRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_codes")
    .insert({ user_id: userId, code })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return null; // established convention — see affiliateCommission.repository.ts
    throw error;
  }
  return data;
};

// ─── referral_attributions (shared with the affiliate system) ─────────────

export type ReferralAttributionRow = {
  id: string;
  user_id: string;
  affiliate_id: string | null;
  referrer_user_id: string | null;
  attribution_type: "affiliate" | "referral" | null;
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

/** Signup date, for the grace-period window check (affiliate doc §2.3 /
 * design doc §2.4: 14 days, not retroactive). Same profiles.created_at
 * convention introEmail.service.ts already relies on. */
export const findProfileCreatedAt = async (
  userId: string,
): Promise<string | null> => {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("created_at")
    .eq("id", userId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data?.created_at ?? null;
};

export type InsertAttributionInput = {
  user_id: string;
  affiliate_id: string | null;
  referrer_user_id: string | null;
  attribution_type: "affiliate" | "referral" | null;
  raw_code_entered: string | null;
  resolved: boolean;
  source: string;
};

/** Returns null if a row already exists for this user (UNIQUE(user_id)) —
 * "one attribution per user, first one wins" enforced at the DB level. */
export const insertAttribution = async (
  input: InsertAttributionInput,
): Promise<ReferralAttributionRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_attributions")
    .insert(input)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return null;
    throw error;
  }
  return data;
};

// ─── referral_rewards ───────────────────────────────────────────────────────

export type ReferralRewardRow = {
  id: string;
  referrer_user_id: string;
  referred_user_id: string;
  attribution_id: string;
  status: "pending" | "qualified" | "granted" | "revoked" | "expired";
  qualifying_event_type: "ai_grading_report" | null;
  qualifying_event_id: string | null;
  qualified_at: string | null;
  reward_type: "pro_month";
  comp_subscription_id: string | null;
  granted_period_start: string | null;
  granted_period_end: string | null;
  granted_at: string | null;
  is_revocation: boolean;
  revoked_of: string | null;
  revoked_reason: string | null;
  created_at: string;
};

export const insertPendingReward = async (
  referrerUserId: string,
  referredUserId: string,
  attributionId: string,
): Promise<ReferralRewardRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_rewards")
    .insert({
      referrer_user_id: referrerUserId,
      referred_user_id: referredUserId,
      attribution_id: attributionId,
      status: "pending",
      reward_type: "pro_month",
    })
    .select("*")
    .single();
  if (error) {
    if (error.code === "23505") return null; // referral_rewards_attribution_unique
    throw error;
  }
  return data;
};

export const findPendingRewardByReferredUserId = async (
  referredUserId: string,
): Promise<ReferralRewardRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_rewards")
    .select("*")
    .eq("referred_user_id", referredUserId)
    .eq("status", "pending")
    .eq("is_revocation", false)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

export const markRewardQualified = async (
  rewardId: string,
  qualifyingEventId: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("referral_rewards")
    .update({
      status: "qualified",
      qualifying_event_type: "ai_grading_report",
      qualifying_event_id: qualifyingEventId,
      qualified_at: new Date().toISOString(),
    })
    .eq("id", rewardId)
    .eq("status", "pending"); // set-once guard — never re-qualify an already-qualified/granted row
  if (error) throw error;
};

export const markRewardGranted = async (
  rewardId: string,
  compSubscriptionId: string,
  periodStart: string,
  periodEnd: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("referral_rewards")
    .update({
      status: "granted",
      comp_subscription_id: compSubscriptionId,
      granted_period_start: periodStart,
      granted_period_end: periodEnd,
      granted_at: new Date().toISOString(),
    })
    .eq("id", rewardId)
    .eq("status", "qualified"); // set-once guard
  if (error) throw error;
};

/** Cap accounting (design doc §3.2) — granted, non-revoked, trailing 365
 * days, excluding any grant that has since been reversed by a revocation
 * row referencing it. */
export const countGrantedRewardsInTrailingYear = async (
  referrerUserId: string,
): Promise<number> => {
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - 365);
  const { data: granted, error } = await supabaseAdmin
    .from("referral_rewards")
    .select("id")
    .eq("referrer_user_id", referrerUserId)
    .eq("status", "granted")
    .eq("is_revocation", false)
    .gte("granted_at", since.toISOString());
  if (error) throw error;
  if (!granted || granted.length === 0) return 0;

  const ids = granted.map((r) => r.id);
  const { data: revocations, error: revErr } = await supabaseAdmin
    .from("referral_rewards")
    .select("revoked_of")
    .eq("is_revocation", true)
    .in("revoked_of", ids);
  if (revErr) throw revErr;
  const revokedSet = new Set((revocations ?? []).map((r) => r.revoked_of));
  return ids.filter((id) => !revokedSet.has(id)).length;
};

export const findMostRecentGrantedRewardForReferrer = async (
  referrerUserId: string,
): Promise<ReferralRewardRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("referral_rewards")
    .select("*")
    .eq("referrer_user_id", referrerUserId)
    .eq("status", "granted")
    .eq("is_revocation", false)
    .order("granted_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

export const listRewardsForReferrer = async (
  referrerUserId: string,
): Promise<ReferralRewardRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("referral_rewards")
    .select("*")
    .eq("referrer_user_id", referrerUserId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
};

/** Sweep target (design doc §3.3) — qualified rows waiting on cap room,
 * oldest first. */
export const listQualifiedRewardsAwaitingGrant = async (
  limit = 200,
): Promise<ReferralRewardRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("referral_rewards")
    .select("*")
    .eq("status", "qualified")
    .order("qualified_at", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
};

export const markRewardExpired = async (rewardId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("referral_rewards")
    .update({ status: "expired" })
    .eq("id", rewardId)
    .eq("status", "qualified");
  if (error) throw error;
};

// ─── subscriptions (comp-row grant/stack — design doc §4) ──────────────────

export type CompSubscriptionRow = {
  id: string;
  user_id: string;
  status: string;
  current_period_end: string | null;
};

/** The user's current active/trialing comp row for the given comp_reason,
 * if any — platform-scoped, matching grantCompPro's established safe
 * pattern (never looks at a real stripe/apple/google row). */
export const findActiveCompRowByReason = async (
  userId: string,
  compReason: "referral_reward" | "referral_welcome",
): Promise<CompSubscriptionRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id, user_id, status, current_period_end")
    .eq("user_id", userId)
    .eq("platform", "comp")
    .eq("comp_reason", compReason)
    .in("status", ["active", "trialing"])
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ?? null;
};

export const insertCompGrant = async (
  userId: string,
  compReason: "referral_reward" | "referral_welcome",
  periodEndIso: string,
): Promise<CompSubscriptionRow> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .insert({
      user_id: userId,
      platform: "comp",
      comp_reason: compReason,
      plan: "pro",
      status: "active",
      current_period_end: periodEndIso,
    })
    .select("id, user_id, status, current_period_end")
    .single();
  if (error) throw error;
  return data;
};

export const extendCompGrant = async (
  subscriptionId: string,
  newPeriodEndIso: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ current_period_end: newPeriodEndIso, updated_at: new Date().toISOString() })
    .eq("id", subscriptionId);
  if (error) throw error;
};

/** Set-once guard for the referral_welcome grant — one per user, ever. */
export const hasAnyCompGrantForReason = async (
  userId: string,
  compReason: "referral_reward" | "referral_welcome",
): Promise<boolean> => {
  const { count, error } = await supabaseAdmin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("platform", "comp")
    .eq("comp_reason", compReason);
  if (error) throw error;
  return (count ?? 0) > 0;
};

/** Mirrors vendorCode.service.ts / updateUserPlan's own convention: "we
 * already gave this user a comp benefit, don't also dangle the app's own
 * free-trial copy in front of them" (mobile paywall.tsx's only read of
 * this field — cosmetic, not an entitlement gate; Apple/Google's own
 * systems are the real authority on trial eligibility). The referral
 * welcome bonus is exactly this same case and was missing this call. */
export const markTrialUsed = async (userId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ trial_used: true })
    .eq("id", userId);
  if (error) throw error;
};

// ─── ai_grading_reports (qualification signal — design doc Finding 3) ─────

export const countCompletedAiGradingReports = async (
  userId: string,
): Promise<number> => {
  const { count, error } = await supabaseAdmin
    .from("ai_grading_reports")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("status", "completed");
  if (error) throw error;
  return count ?? 0;
};

/** Qualifying report to link on the reward row. Only ever consulted once
 * both conditions are already known to be met (referralReward.service.ts's
 * checkAndQualify) — an inventory-triggered call doesn't have a report id
 * on hand the way the grading call site does, so it looks up their first
 * completed report here instead. */
export const findFirstCompletedAiGradingReportId = async (
  userId: string,
): Promise<string | null> => {
  const { data, error } = await supabaseAdmin
    .from("ai_grading_reports")
    .select("id")
    .eq("user_id", userId)
    .eq("status", "completed")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data?.id ?? null;
};

// ─── inventory (second qualification signal, ruled 2026-09-02) ────────────

/** "Cards added to inventory" — raw_card and graded_card rows only, a
 * sealed pack sitting unopened isn't "a card" in the spirit of the rule
 * (grading shows them the magic, inventory is what brings them back).
 * Row count, not summed quantity — a single bulk-quantity add isn't the
 * same signal as N separate additions. Both are one-line calls to change
 * if that reading turns out wrong once there's real data to look at. */
export const countInventoryCards = async (userId: string): Promise<number> => {
  const { count, error } = await supabaseAdmin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .in("item_type", ["raw_card", "graded_card"]);
  if (error) throw error;
  return count ?? 0;
};

// attribution.service.ts
//
// The shared code resolver AUDITS/affiliate-system-plan.md §2.3 designed
// and never built, and AUDITS/referral-program-plan.md §2.2 generalized to
// serve both programs. This is its first real implementation.
//
// Precedence, exactly as both docs specify: affiliate slug checked first
// (a small, admin-curated namespace), then a personal referral code.
// "One attribution per user, first one wins" is enforced by
// referral_attributions.user_id's UNIQUE constraint (Phase 0 of the
// affiliate plan) — insertAttribution returning null on a 23505 IS that
// rule, not a separate check.
//
// GATES BEHAVIOR, not just visibility (your own CRITICAL instruction):
// both feature flags are checked HERE, before any write, for the specific
// user being resolved. A flag-off user's call to this function is
// guaranteed to write nothing — not "the button is hidden so they never
// call it," an actual server-side no-op regardless of what any client does.

import {
  findAttributionByUserId,
  insertAttribution,
  findActiveAffiliateBySlug,
  findReferralCodeByCode,
  insertPendingReward,
  insertCompGrant,
  hasAnyCompGrantForReason,
  findProfileCreatedAt,
} from "../repositories/referral.repository";
import { isFlagEnabled } from "./featureFlag.service";
import { FLAG_KEYS } from "../constants/featureFlagKeys";
import { logError } from "../lib/Logger";

export type AttributionSource =
  | "web_cookie"
  | "web_manual"
  | "mobile_manual"
  | "post_signup_grace";

export type ResolveOutcome =
  | { outcome: "resolved_affiliate"; attributionId: string }
  | { outcome: "resolved_referral"; attributionId: string }
  | { outcome: "unresolved"; attributionId: string }
  | { outcome: "already_attributed" }
  | { outcome: "self_referral_blocked" }
  | { outcome: "no_code" }
  | { outcome: "flags_off" }
  | { outcome: "grace_period_expired"; daysSinceSignup: number };

const WELCOME_BONUS_DAYS = 7;
// Design doc §2.4 / affiliate doc §2.3: 14 days post-signup, and — per the
// doc's own reasoning, unchanged here — NOT retroactive to payments already
// made. That second half doesn't need separate code: window_start is set
// at first PAYMENT regardless of when attribution happens (recordEarning /
// referralReward.service.ts), so a grace-period attribution still gets its
// full window forward from whenever the user actually converts — it just
// never reaches backward. This constant is the other half: how long the
// grace endpoint stays callable at all.
const GRACE_PERIOD_DAYS = 14;

const addDaysIso = (days: number): string => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
};

/**
 * Grants the referred friend's welcome bonus (design doc §1: a 7-day Pro
 * trial, not "extra gradings" — reuses the exact comp-row mechanism
 * grantCompPro/redeemVendorCode already use, no new machinery). One per
 * user, ever — guarded, not just best-effort.
 */
async function grantWelcomeBonus(userId: string): Promise<void> {
  const already = await hasAnyCompGrantForReason(userId, "referral_welcome");
  if (already) return;
  await insertCompGrant(userId, "referral_welcome", addDaysIso(WELCOME_BONUS_DAYS));
}

export interface ResolveAttributionParams {
  userId: string;
  rawCode: string | null | undefined;
  source: AttributionSource;
  role: string | null;
}

export async function resolveAttribution(
  params: ResolveAttributionParams,
): Promise<ResolveOutcome> {
  const { userId, rawCode, source, role } = params;

  const code = (rawCode ?? "").trim();
  if (!code) return { outcome: "no_code" };

  // "First one wins" — a pre-existing row (of either type) means this call
  // does nothing further, regardless of what code is now being offered.
  const existing = await findAttributionByUserId(userId);
  if (existing) return { outcome: "already_attributed" };

  // Grace-period window — only checked for the grace-period source itself.
  // The at-signup sources (web_cookie/web_manual/mobile_manual) are always
  // ~0 days post-signup by construction; skipping the lookup for them
  // avoids a wasted profile read on the common path.
  if (source === "post_signup_grace") {
    const createdAt = await findProfileCreatedAt(userId);
    if (createdAt) {
      const daysSinceSignup = (Date.now() - new Date(createdAt).getTime()) / (24 * 3600 * 1000);
      if (daysSinceSignup > GRACE_PERIOD_DAYS) {
        return { outcome: "grace_period_expired", daysSinceSignup: Math.floor(daysSinceSignup) };
      }
    }
  }

  const [affiliateFlagOn, referralFlagOn] = await Promise.all([
    isFlagEnabled(FLAG_KEYS.AFFILIATE_PROGRAM, userId, role),
    isFlagEnabled(FLAG_KEYS.REFERRAL_PROGRAM, userId, role),
  ]);
  if (!affiliateFlagOn && !referralFlagOn) {
    // No row at all — not even an unresolved one. A flag-off user leaves
    // ZERO trace in referral_attributions from this call, which is the
    // literal meaning of "byte-identical to today" at the data layer.
    return { outcome: "flags_off" };
  }

  const normalized = code.toLowerCase();

  // §2.2 precedence: affiliate slug first.
  if (affiliateFlagOn) {
    const affiliate = await findActiveAffiliateBySlug(normalized);
    if (affiliate) {
      const row = await insertAttribution({
        user_id: userId,
        affiliate_id: affiliate.id,
        referrer_user_id: null,
        attribution_type: "affiliate",
        raw_code_entered: code,
        resolved: true,
        source,
      });
      if (!row) return { outcome: "already_attributed" };
      return { outcome: "resolved_affiliate", attributionId: row.id };
    }
  }

  if (referralFlagOn) {
    const referralCode = await findReferralCodeByCode(normalized);
    if (referralCode) {
      // Self-application — §5 of the referral doc. Structurally the only
      // place this check matters: a brand-new signup can never reference
      // its own not-yet-created code, so this only ever fires on the
      // authenticated grace-period path (an existing user applying their
      // own code to themselves after the fact).
      if (referralCode.user_id === userId) {
        return { outcome: "self_referral_blocked" };
      }

      const row = await insertAttribution({
        user_id: userId,
        affiliate_id: null,
        referrer_user_id: referralCode.user_id,
        attribution_type: "referral",
        raw_code_entered: code,
        resolved: true,
        source,
      });
      if (!row) return { outcome: "already_attributed" };

      // referral_rewards row created at 'pending' the moment attribution
      // resolves — design doc §3.1 step 1, not deferred to qualification.
      try {
        await insertPendingReward(referralCode.user_id, userId, row.id);
      } catch (err) {
        await logError({
          source: "referral-attribution",
          message: "Failed to create pending referral_rewards row",
          error: err,
          userId,
          requestPath: "",
          requestMethod: "",
          metadata: { attributionId: row.id },
        });
      }

      // Welcome bonus for the referred friend — best-effort, never blocks
      // attribution itself from succeeding.
      try {
        await grantWelcomeBonus(userId);
      } catch (err) {
        await logError({
          source: "referral-attribution",
          message: "Failed to grant welcome bonus",
          error: err,
          userId,
          requestPath: "",
          requestMethod: "",
          metadata: { attributionId: row.id },
        });
      }

      return { outcome: "resolved_referral", attributionId: row.id };
    }
  }

  // Unresolved — stored regardless (affiliate doc §0.3/§2.3: never
  // silently drop a typo'd or made-up code). Only reached when at least
  // one flag is on for this user, so this still respects "flags_off means
  // zero rows" above.
  const row = await insertAttribution({
    user_id: userId,
    affiliate_id: null,
    referrer_user_id: null,
    attribution_type: null,
    raw_code_entered: code,
    resolved: false,
    source,
  });
  if (!row) return { outcome: "already_attributed" };
  return { outcome: "unresolved", attributionId: row.id };
}

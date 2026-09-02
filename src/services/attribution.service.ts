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
  markTrialUsed,
} from "../repositories/referral.repository";
import { redeemVendorCode, VendorCodeError } from "./vendorCode.service";
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
  // Code-entry consolidation (ruled 2026-09-02): a vendor/event code is a
  // direct benefit redemption, not an attribution relationship — carries
  // redeemVendorCode's own RedeemResult shape so the client can show the
  // same confirmation event-code.tsx always has.
  | {
      outcome: "resolved_vendor";
      plan: string;
      durationMonths: number;
      description: string | null;
    }
  // The code matched a real vendor code but couldn't be redeemed for a
  // specific reason (expired/exhausted/already redeemed/unsupported type)
  // — message is VendorCodeError's own user-facing text, unchanged from
  // what event-code.tsx/profile/redeem.tsx already show today.
  | { outcome: "vendor_code_error"; message: string }
  | { outcome: "unresolved" }
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
  // Found during the 2026-09-02 trial-copy fact-check: every other comp-
  // granting path (vendorCode.service.ts, updateUserPlan) marks trial_used
  // so the app's own paywall copy doesn't ALSO promise a free trial on top
  // of a benefit we just gave them. This grant was missing that call.
  await markTrialUsed(userId);
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

  // Vendor/event codes (code-entry consolidation, ruled 2026-09-02) —
  // checked FIRST and entirely independent of everything below: a vendor
  // code is a direct benefit redemption, not "who referred you," so it
  // must work regardless of whether this user already has a referral/
  // affiliate attribution (never touches referral_attributions at all —
  // vendor_code_redemptions' own per-user-per-code check is the only guard
  // it needs), and isn't subject to the referral grace-period window below
  // (that window is a referral/affiliate business rule, not a vendor-code
  // one — a card-show code isn't "retroactive" in any sense that applies).
  //
  // DELIBERATELY NOT gated behind referral_program, unlike the rest of
  // this consolidation — vendor-code redemption has NEVER been flag-gated
  // (event-code.tsx and profile/redeem.tsx both worked unconditionally for
  // every user), and the login screen's "Event code" button was removed
  // outright, not flag-gated, leaving THIS the only pre-signup path left
  // for a vendor code. Gating it here would silently break vendor-code
  // redemption for every non-allowlisted user the moment that button was
  // gone — exactly the "breaks silently at a card show" risk this whole
  // consolidation was reviewed against. Only affiliate/referral resolution
  // below stays flag-gated, unchanged from before this branch existed.
  try {
    const result = await redeemVendorCode(userId, code);
    return {
      outcome: "resolved_vendor",
      plan: result.plan,
      durationMonths: result.durationMonths,
      description: result.description,
    };
  } catch (err) {
    if (err instanceof VendorCodeError) {
      if (err.code !== "NOT_FOUND") {
        // A real vendor code that matched but couldn't be redeemed
        // (expired/exhausted/already redeemed/unsupported) — report
        // that specifically rather than falling through to "that code
        // doesn't look right" for an obviously-real code.
        return { outcome: "vendor_code_error", message: err.message };
      }
      // NOT_FOUND — not a vendor code at all, fall through below.
    } else {
      throw err;
    }
  }

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

  // Unrecognized — NEVER write a row (invariant added 2026-09-02: "never
  // burn the slot"). This used to store an `unresolved` row so a later real
  // match ("REDDIT" turning out to be real) would stay queryable (affiliate
  // doc §0.3/§2.3) — but referral_attributions.user_id is UNIQUE, and
  // findAttributionByUserId's already_attributed check above doesn't
  // distinguish resolved from unresolved, so that row permanently locked
  // this user out of ever entering a REAL code afterward. Harmless while
  // "unresolved" only ever meant a rare human typo; unacceptable once code-
  // entry consolidation made "doesn't match anything" a routine event (a
  // stale/mistyped/wrong-show vendor code, not just a referral typo) —
  // losing the queryable-typo data is the smaller cost. The slot stays
  // free: this user can immediately try a real code next.
  return { outcome: "unresolved" };
}

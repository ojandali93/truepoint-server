// referralReward.service.ts
//
// Qualification (Finding 3: ai_grading_reports.status='completed' is the
// signal, no new instrumentation) and the reward grant (design doc §4 —
// comp-row overlay, stacking against the referrer's own existing referral-
// reward comp row rather than the real subscription it may run alongside).

import {
  findPendingRewardByReferredUserId,
  markRewardQualified,
  markRewardGranted,
  countCompletedAiGradingReports,
  findFirstCompletedAiGradingReportId,
  countInventoryCards,
  countGrantedRewardsInTrailingYear,
  findActiveCompRowByReason,
  insertCompGrant,
  extendCompGrant,
  listRewardsForReferrer,
  findReferralCodeByUserId,
  insertReferralCode,
  listQualifiedRewardsAwaitingGrant,
  markRewardExpired,
} from "../repositories/referral.repository";
import { logError } from "../lib/Logger";

const ANNUAL_CAP = 12;
const QUALIFIED_EXPIRY_DAYS = 60;

// Ruled 2026-09-02: qualification now requires BOTH conditions, not just
// the grading one — grading shows a referred user the magic, inventory is
// what brings them back. This is the ONLY place the card-count number
// lives; tune it here, no migration, nothing else to keep in sync — the
// referral-summary API reads this same constant into its response
// (cardsRequired) so the app's copy and per-referral "cards N of M"
// progress can never drift from what actually gates the reward, the same
// class of bug the trial-day copy fix (2026-09-02) closed for good.
export const REFERRAL_INVENTORY_THRESHOLD = 3;

const addMonthsIso = (fromIso: string, months: number): string => {
  const d = new Date(fromIso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
};

export type QualificationOutcome =
  | { outcome: "no_pending_referral" }
  | {
      outcome: "not_yet_qualified";
      graded: boolean;
      cardsAdded: number;
      cardsRequired: number;
    } // one or both conditions still outstanding
  | { outcome: "qualified_capped"; rewardId: string } // qualified, waiting on cap room
  | { outcome: "qualified_and_granted"; rewardId: string; compSubscriptionId: string };

/**
 * Shared by both trigger points (grading completion, every inventory-add
 * write path) — whichever of the two conditions completes SECOND is what
 * actually qualifies the reward, so both call sites run this exact same
 * check rather than each owning half of it. Idempotent: markRewardQualified
 * only ever fires on a 'pending' row (its own set-once guard), so calling
 * this after qualification has already happened is a harmless no-op.
 *
 * qualifyingReportId is the report to link on the reward row once both
 * conditions are met. The grading call site already has it in hand; an
 * inventory-triggered call doesn't (grading may have completed well
 * before this specific inventory add), so it's looked up here instead —
 * by construction, if `graded` is true, one exists.
 */
async function checkAndQualify(
  referredUserId: string,
  qualifyingReportId: string | null,
): Promise<QualificationOutcome> {
  const pending = await findPendingRewardByReferredUserId(referredUserId);
  if (!pending) return { outcome: "no_pending_referral" };

  const [gradedCount, cardsAdded] = await Promise.all([
    countCompletedAiGradingReports(referredUserId),
    countInventoryCards(referredUserId),
  ]);
  const graded = gradedCount >= 1;
  const cardsQualified = cardsAdded >= REFERRAL_INVENTORY_THRESHOLD;

  if (!graded || !cardsQualified) {
    return {
      outcome: "not_yet_qualified",
      graded,
      cardsAdded,
      cardsRequired: REFERRAL_INVENTORY_THRESHOLD,
    };
  }

  const reportId =
    qualifyingReportId ?? (await findFirstCompletedAiGradingReportId(referredUserId));
  if (!reportId) {
    // Defensive only — graded=true (gradedCount >= 1) makes this
    // unreachable in practice; markRewardQualified requires a non-null id.
    throw new Error(
      `Referral qualification: graded but no completed report found for user ${referredUserId}`,
    );
  }

  await markRewardQualified(pending.id, reportId);

  return attemptGrant(pending.referrer_user_id, pending.id);
}

/**
 * Called from the AI grading completion write path. Cheap no-op for the
 * ~100% of completions with no pending referral — one lookup, then done.
 */
export async function recordReferralQualification(
  referredUserId: string,
  qualifyingReportId: string,
): Promise<QualificationOutcome> {
  return checkAndQualify(referredUserId, qualifyingReportId);
}

/**
 * Same cheap-no-op shape as the grading path. Real write paths (single
 * add, sealed-pull batch, CSV import batch, trade acceptance) all call the
 * Safe wrapper below, not this directly — exported for composability and
 * so a caller that wants the actual outcome (verification scripts) can get
 * one, same as recordReferralQualification.
 */
export async function recordReferralInventoryQualification(
  referredUserId: string,
): Promise<QualificationOutcome> {
  return checkAndQualify(referredUserId, null);
}

/**
 * Four separate write paths call this (vs. the grading path's one), so the
 * "never fail the caller" guarantee — aiGrading.controller.ts wraps its own
 * call to recordReferralQualification the same way — is centralized here
 * once instead of copy-pasted four times.
 */
export async function recordReferralInventoryQualificationSafe(
  referredUserId: string,
): Promise<void> {
  try {
    await recordReferralInventoryQualification(referredUserId);
  } catch (err) {
    await logError({
      source: "referral-inventory-qualification",
      message: "Failed to process referral inventory qualification",
      error: err,
      userId: referredUserId,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
  }
}

async function attemptGrant(
  referrerUserId: string,
  rewardId: string,
): Promise<QualificationOutcome> {
  const grantedThisYear = await countGrantedRewardsInTrailingYear(referrerUserId);
  if (grantedThisYear >= ANNUAL_CAP) {
    // Stays 'qualified' — the sweep (runReferralGrantSweep) retries once
    // cap room opens up, or expires it after QUALIFIED_EXPIRY_DAYS.
    return { outcome: "qualified_capped", rewardId };
  }

  const existing = await findActiveCompRowByReason(referrerUserId, "referral_reward");
  let compSubscriptionId: string;
  let periodStart: string;
  let periodEnd: string;

  if (existing && existing.current_period_end) {
    // Stacking (design doc §4): extend the existing grant by another
    // month rather than inserting a second concurrent comp row, which
    // resolvePlan's max-based logic would just render redundant.
    periodStart = existing.current_period_end;
    periodEnd = addMonthsIso(existing.current_period_end, 1);
    await extendCompGrant(existing.id, periodEnd);
    compSubscriptionId = existing.id;
  } else {
    const now = new Date().toISOString();
    periodStart = now;
    periodEnd = addMonthsIso(now, 1);
    const inserted = await insertCompGrant(referrerUserId, "referral_reward", periodEnd);
    compSubscriptionId = inserted.id;
  }

  await markRewardGranted(rewardId, compSubscriptionId, periodStart, periodEnd);
  return { outcome: "qualified_and_granted", rewardId, compSubscriptionId };
}

// ─── /me/referral-code — lazy generation (design doc §2.1) ─────────────────

const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // base32-ish, minus 0/O/1/I/L

function randomCode(length = 7): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await findReferralCodeByUserId(userId);
  if (existing) return existing.code;

  // §2.3: collision-checked against both namespaces via insertReferralCode's
  // own UNIQUE(code) — findActiveAffiliateBySlug isn't re-checked here
  // per draw since affiliate slugs are hand-chosen words, not random
  // strings from this exact alphabet; a real collision is only possible
  // against another referral_codes row, which the retry loop below covers.
  for (let attempt = 0; attempt < 5; attempt++) {
    const row = await insertReferralCode(userId, randomCode());
    if (row) return row.code;

    // A 23505 here has two different causes now that getReferralSummary
    // (2026-09-02 fix) calls this on every summary fetch until a code
    // exists: a genuine code collision (retry with a new draw is right),
    // or a concurrent request for the SAME user winning the user_id-UNIQUE
    // race (e.g. two overlapping pull-to-refreshes) — retrying blindly in
    // that case wastes attempts and can still throw for a user who already
    // has a code. Check before the next draw so a lost race returns the
    // winner's code instead of erroring.
    const raced = await findReferralCodeByUserId(userId);
    if (raced) return raced.code;
  }
  throw Object.assign(new Error("Failed to generate a unique referral code"), {
    status: 500,
  });
}

// ─── /me/referral-summary ───────────────────────────────────────────────────

export interface ReferralSummary {
  code: string;
  referredCount: number;
  qualifiedCount: number; // includes granted (granted implies qualified)
  grantedMonthsThisYear: number;
  cardsRequired: number; // REFERRAL_INVENTORY_THRESHOLD — so the app never hardcodes it
  rewards: Array<{
    id: string;
    referredUserId: string;
    status: string;
    createdAt: string;
    qualifiedAt: string | null;
    grantedAt: string | null;
    grantedPeriodStart: string | null;
    grantedPeriodEnd: string | null;
    // Live per-referral progress toward BOTH conditions — only computed
    // for 'pending' rows (design doc §2.4 UX ruling, 2026-09-02: the
    // referrer must be able to see WHY a referral hasn't qualified, not
    // just an opaque count). null for qualified/granted (both conditions
    // were already met) and revoked/expired (nothing left to show).
    progress: { graded: boolean; cardsAdded: number } | null;
  }>;
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  // 2026-09-02 bug fix: this used to read findReferralCodeByUserId directly
  // — a personal code was designed to generate lazily on first view (§2.1),
  // but this, the screen's one call, never actually triggered that
  // generation (only GET /me/referral-code did, and nothing ever called
  // it). getOrCreateReferralCode makes this endpoint itself the "first
  // view" trigger, so every existing code-less user gets one the moment
  // they next load this screen — the fix IS the backfill, no migration.
  const [code, rewards] = await Promise.all([
    getOrCreateReferralCode(userId),
    listRewardsForReferrer(userId),
  ]);

  const primaryRows = rewards.filter((r) => !r.is_revocation);
  const qualifiedCount = primaryRows.filter(
    (r) => r.status === "qualified" || r.status === "granted",
  ).length;
  const grantedMonthsThisYear = await countGrantedRewardsInTrailingYear(userId);

  const progressByRewardId = new Map<string, { graded: boolean; cardsAdded: number }>();
  const pendingRows = primaryRows.filter((r) => r.status === "pending");
  await Promise.all(
    pendingRows.map(async (r) => {
      const [gradedCount, cardsAdded] = await Promise.all([
        countCompletedAiGradingReports(r.referred_user_id),
        countInventoryCards(r.referred_user_id),
      ]);
      progressByRewardId.set(r.id, { graded: gradedCount >= 1, cardsAdded });
    }),
  );

  return {
    code,
    referredCount: primaryRows.length,
    qualifiedCount,
    grantedMonthsThisYear,
    cardsRequired: REFERRAL_INVENTORY_THRESHOLD,
    rewards: primaryRows.map((r) => ({
      id: r.id,
      referredUserId: r.referred_user_id,
      status: r.status,
      createdAt: r.created_at,
      qualifiedAt: r.qualified_at,
      grantedAt: r.granted_at,
      grantedPeriodStart: r.granted_period_start,
      grantedPeriodEnd: r.granted_period_end,
      progress: progressByRewardId.get(r.id) ?? null,
    })),
  };
}

// ─── Grant sweep (design doc §3.3) ──────────────────────────────────────────

export interface SweepResult {
  granted: number;
  expired: number;
  stillCapped: number;
}

export async function runReferralGrantSweep(): Promise<SweepResult> {
  const rows = await listQualifiedRewardsAwaitingGrant();
  const result: SweepResult = { granted: 0, expired: 0, stillCapped: 0 };
  const now = Date.now();

  for (const row of rows) {
    try {
      const qualifiedAt = row.qualified_at ? new Date(row.qualified_at).getTime() : now;
      const ageDays = (now - qualifiedAt) / (24 * 3600 * 1000);

      const outcome = await attemptGrant(row.referrer_user_id, row.id);
      if (outcome.outcome === "qualified_and_granted") {
        result.granted++;
        continue;
      }

      // Still capped — expire if past the window, otherwise leave it for
      // the next sweep run.
      if (ageDays > QUALIFIED_EXPIRY_DAYS) {
        await markRewardExpired(row.id);
        result.expired++;
      } else {
        result.stillCapped++;
      }
    } catch (err) {
      await logError({
        source: "referral-grant-sweep",
        message: "Failed to process a qualified reward",
        error: err,
        userId: row.referrer_user_id,
        requestPath: "",
        requestMethod: "",
        metadata: { rewardId: row.id },
      });
    }
  }

  return result;
}

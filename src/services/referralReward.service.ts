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

const addMonthsIso = (fromIso: string, months: number): string => {
  const d = new Date(fromIso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
};

export type QualificationOutcome =
  | { outcome: "no_pending_referral" }
  | { outcome: "not_first_grading" }
  | { outcome: "qualified_capped"; rewardId: string } // qualified, waiting on cap room
  | { outcome: "qualified_and_granted"; rewardId: string; compSubscriptionId: string };

/**
 * Called from the AI grading completion write path. Cheap no-op for the
 * ~100% of completions with no pending referral — one lookup, then done.
 */
export async function recordReferralQualification(
  referredUserId: string,
  qualifyingReportId: string,
): Promise<QualificationOutcome> {
  const pending = await findPendingRewardByReferredUserId(referredUserId);
  if (!pending) return { outcome: "no_pending_referral" };

  // Re-check this is genuinely their FIRST completed report — a race
  // guard, not the primary check (the primary check is "a pending reward
  // exists at all," which by construction only exists for a user who was
  // just attributed and hasn't graded before).
  const completedCount = await countCompletedAiGradingReports(referredUserId);
  if (completedCount !== 1) return { outcome: "not_first_grading" };

  await markRewardQualified(pending.id, qualifyingReportId);

  return attemptGrant(pending.referrer_user_id, pending.id);
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
  }
  throw Object.assign(new Error("Failed to generate a unique referral code"), {
    status: 500,
  });
}

// ─── /me/referral-summary ───────────────────────────────────────────────────

export interface ReferralSummary {
  code: string | null;
  referredCount: number;
  qualifiedCount: number; // includes granted (granted implies qualified)
  grantedMonthsThisYear: number;
  rewards: Array<{
    id: string;
    referredUserId: string;
    status: string;
    createdAt: string;
    qualifiedAt: string | null;
    grantedAt: string | null;
    grantedPeriodStart: string | null;
    grantedPeriodEnd: string | null;
  }>;
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const [codeRow, rewards] = await Promise.all([
    findReferralCodeByUserId(userId),
    listRewardsForReferrer(userId),
  ]);

  const primaryRows = rewards.filter((r) => !r.is_revocation);
  const qualifiedCount = primaryRows.filter(
    (r) => r.status === "qualified" || r.status === "granted",
  ).length;
  const grantedMonthsThisYear = await countGrantedRewardsInTrailingYear(userId);

  return {
    code: codeRow?.code ?? null,
    referredCount: primaryRows.length,
    qualifiedCount,
    grantedMonthsThisYear,
    rewards: primaryRows.map((r) => ({
      id: r.id,
      referredUserId: r.referred_user_id,
      status: r.status,
      createdAt: r.created_at,
      qualifiedAt: r.qualified_at,
      grantedAt: r.granted_at,
      grantedPeriodStart: r.granted_period_start,
      grantedPeriodEnd: r.granted_period_end,
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

// src/services/featureFlag.service.ts
//
// Per-user feature-flag resolution.
//
// This is DELIBERATELY separate from plan.service.ts. The two answer
// different questions and must not be conflated:
//
//   plan.service.ts  → "does your SUBSCRIPTION TIER include this?"  (entitlement)
//   this file        → "has this been SHIPPED to you yet?"          (rollout)
//
// Hence the distinct vocabulary: FlagKey / isFlagEnabled / requireFlag,
// versus FeatureKey / hasFeature / requireFeature. A feature can be gated
// by both — plan says you're allowed it, flag says it exists for you yet.

import crypto from "crypto";

import { TTLCache } from "../lib/cache";
import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";

// ─── Types ──────────────────────────────────────────────────────────────────

export type FlagAudience =
  | "off" // nobody
  | "allowlist" // only allowed_user_ids
  | "admins" // all admin accounts
  | "percentage" // stable N% of users
  | "everyone"; // GA

export interface FeatureFlagRow {
  id: string;
  key: string;
  enabled: boolean;
  audience: FlagAudience;
  allowed_user_ids: string[] | null;
  rollout_percentage: number | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  updated_by: string | null;
}

export const FLAG_AUDIENCES: FlagAudience[] = [
  "off",
  "allowlist",
  "admins",
  "percentage",
  "everyone",
];

export const FLAG_COLUMNS =
  "id, key, enabled, audience, allowed_user_ids, rollout_percentage, description, metadata, created_at, updated_at, updated_by" as const;

// ─── Cache ──────────────────────────────────────────────────────────────────
// Every /me/plan call resolves flags, and /me/plan runs on app boot for every
// user. Without a cache that's an extra DB round-trip on every cold start.
// The table has single-digit rows, so we cache the whole thing.

const CACHE_KEY = "feature_flags:all";
const CACHE_TTL_MS = 30_000;

const flagCache = new TTLCache<FeatureFlagRow[]>();

/** Call after any write so admins see their change immediately. */
export const invalidateFlagCache = (): void => {
  flagCache.delete(CACHE_KEY);
};

/**
 * Fetch every flag row. Throws on DB failure — callers decide whether that
 * should be fatal. (getPlanSnapshot deliberately swallows it; see below.)
 */
export const getAllFlags = async (): Promise<FeatureFlagRow[]> => {
  const cached = flagCache.get(CACHE_KEY);
  if (cached) return cached;

  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select(FLAG_COLUMNS)
    .order("key");

  if (error) throw error;

  const rows = data ?? [];
  flagCache.set(CACHE_KEY, rows, CACHE_TTL_MS);
  return rows;
};

// ─── Bucketing ──────────────────────────────────────────────────────────────

/**
 * Stable 0–99 bucket for a (flag, user) pair.
 *
 * Hashing `key:userId` rather than userId alone means two different flags at
 * 50% hit two different halves of the userbase — otherwise the same unlucky
 * users would be excluded from every partial rollout forever.
 *
 * Deterministic across processes and restarts, so a user never flips in and
 * out of a rollout between requests.
 */
export const bucketFor = (flagKey: string, userId: string): number => {
  const digest = crypto
    .createHash("sha1")
    .update(`${flagKey}:${userId}`)
    .digest();
  return digest.readUInt32BE(0) % 100;
};

// ─── Evaluation ─────────────────────────────────────────────────────────────

/**
 * Pure, synchronous evaluation of one flag row. No I/O — trivially testable.
 *
 * Precedence:
 *   1. Missing row            → false  (FAIL CLOSED)
 *   2. enabled = false        → false  (master kill switch beats everything)
 *   3. user in allowlist      → true   (additive override, any audience)
 *   4. audience rules
 *
 * Note (3): the allowlist is ADDITIVE, not an exclusive mode. A tester pinned
 * into a flag stays in even when audience is 'percentage' and their hash
 * bucket falls outside the rollout. The 'allowlist' audience value therefore
 * means "nobody EXCEPT the allowlist" — which is exactly the tester tier.
 *
 * Note: admins do NOT auto-pass. This is a deliberate asymmetry with
 * resolvePlan(), which grants admins effectivePlan 'pro'. If admin accounts
 * bypassed every flag, Omar's own account would see all dark features and he
 * would lose the ability to observe the gated state. Use audience 'admins'
 * when you actually want that.
 */
export const evaluateFlag = (
  row: FeatureFlagRow | null | undefined,
  userId: string | null,
  role: string | null = null,
): boolean => {
  if (!row) return false; // unknown flag → fail closed
  if (!row.enabled) return false; // kill switch

  if (userId && (row.allowed_user_ids ?? []).includes(userId)) return true;

  switch (row.audience) {
    case "everyone":
      return true;

    case "admins":
      return role === "admin";

    case "percentage": {
      const pct = row.rollout_percentage ?? 0;
      if (pct <= 0) return false;
      if (pct >= 100) return true;
      if (!userId) return false;
      return bucketFor(row.key, userId) < pct;
    }

    case "allowlist": // handled above; anyone else is out
    case "off":
    default:
      return false;
  }
};

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve every flag for one user → { flagKey: boolean }.
 *
 * IMPORTANT: only booleans leave this function. allowed_user_ids must never
 * reach a client.
 */
export const resolveFlagsForUser = async (
  userId: string,
  role: string | null = null,
): Promise<Record<string, boolean>> => {
  const rows = await getAllFlags();
  const resolved: Record<string, boolean> = {};
  for (const row of rows) {
    resolved[row.key] = evaluateFlag(row, userId, role);
  }
  return resolved;
};

/**
 * Check a single flag. Fails closed on any error — an unreleased feature
 * staying hidden is always the safer failure mode.
 */
export const isFlagEnabled = async (
  key: string,
  userId: string,
  role: string | null = null,
): Promise<boolean> => {
  try {
    const rows = await getAllFlags();
    const row = rows.find((r) => r.key === key) ?? null;
    return evaluateFlag(row, userId, role);
  } catch (err) {
    void logError({
      source: "feature_flags",
      message: `Flag resolution failed for "${key}" — failing closed`,
      error: err,
      userId,
      severity: "error",
    });
    return false;
  }
};

export interface FlagError extends Error {
  status: number;
  code: string;
}

/**
 * Server-side gate for flag-protected endpoints. Mirrors requireFeature()
 * in plan.service.ts.
 *
 * Throws 404, not 403, on purpose: a 403 confirms the endpoint exists, which
 * leaks the shape of unreleased features to anyone probing the API. To a user
 * outside the rollout, a dark feature should be indistinguishable from a
 * feature that was never built.
 */
export const requireFlag = async (
  key: string,
  userId: string,
  role: string | null = null,
): Promise<void> => {
  const ok = await isFlagEnabled(key, userId, role);
  if (!ok) {
    throw Object.assign(new Error("Not found"), {
      status: 404,
      code: "FLAG_NOT_ENABLED",
    }) as FlagError;
  }
};

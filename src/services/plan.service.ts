// src/services/plan.service.ts
//
// Centralized plan/feature/limit enforcement.
// Every plan-gated endpoint imports from here. No scattered `plan === 'pro'`
// logic anywhere else.

import { supabaseAdmin } from "../lib/supabase";
import { resolveFlagsForUser } from "./featureFlag.service";

// ─── Plan keys ──────────────────────────────────────────────────────────────

export type PlanKey = "starter" | "collector" | "pro";

// Plans ordered low → high for "X or higher" checks.
const PLAN_RANK: Record<PlanKey, number> = {
  starter: 0,
  collector: 1,
  pro: 2,
};

// ─── Feature catalogue ──────────────────────────────────────────────────────
// Each feature lists the minimum plan that gets ANY access. Monthly numeric
// limits live separately below.

export type FeatureKey =
  | "inventory_tracking" // raw + graded cards
  | "sealed_inventory" // sealed products in inventory
  | "pack_opening" // open sealed → register pulls
  | "portfolio_dashboard" // full portfolio incl. snapshots + cost basis
  | "regrade_arbitrage" // arbitrage tab
  | "submission_tracking" // create grading submissions
  | "ai_grading"; // AI grading reports

const FEATURE_MIN_PLAN: Record<FeatureKey, PlanKey> = {
  // Starter: raw + graded singles are core, free-tier functionality —
  // adding cards to inventory should never require a paid plan.
  inventory_tracking: "starter",
  sealed_inventory: "starter",
  pack_opening: "collector",
  portfolio_dashboard: "starter",
  // regrade_arbitrage / submission_tracking / ai_grading dropped to
  // "starter" here (UX_OVERHAUL_PLAN.md §7, Phase 1 gate 4) — all three
  // are Free-tier features now, metered separately (see MONTHLY_LIMITS /
  // STATIC_LIMITS below), not plan-gated at all. This is a real behavior
  // change for submission_tracking and ai_grading: both were previously
  // hard-blocked below Collector via requireFeature() — starter users can
  // now reach them and hit the numeric cap instead. regrade_arbitrage's
  // requireFeature/hasFeature was never actually called anywhere (grep-
  // verified), so this entry was already decorative; corrected anyway so
  // features.regrade_arbitrage in /me/plan's response isn't misleading if
  // a future client starts reading it.
  regrade_arbitrage: "starter",
  submission_tracking: "starter",
  ai_grading: "starter",
};

// ─── Monthly limits ─────────────────────────────────────────────────────────
// `null` = unlimited. `0` = blocked (use FEATURE_MIN_PLAN instead, but kept
// here as a safety net).

// submissions moved OUT of monthly limits (Phase 1 gate 4) — "5 active" in
// the new split is a concurrent/pipeline cap (how many are open right now,
// freed up when one reaches its terminal status), not a per-month creation
// count. See StaticLimitKey/STATIC_LIMITS below, and
// gradingLifecycle.service.ts::canCreateMoreSubmissions for the enforcement
// (same resource-local pattern masterSet.service.ts::canTrackMoreSets and
// collection.service.ts already use for static limits).
export type MonthlyLimitKey = "ai_grading_reports" | "regrade_arbitrage_views";

// starter/collector values below are both effectively "Free" tier numbers
// now (UX_OVERHAUL_PLAN.md §7) — the codebase's PlanKey is still 3-way
// pending the actual pricing-product migration (Phase 1 gates 6/7), so
// both existing paid-but-legacy tiers get the same Free-tier numbers here
// until that migration grandfathers real subscribers onto Pro. Flagged to
// Omar: this does reduce the one real Collector subscriber's limits
// (100/mo AI reports, 4/mo submissions, previously-decorative "50/mo"
// arbitrage) down to the new Free numbers until gate 7 ships — sequence
// gate 7 promptly behind this one.
const MONTHLY_LIMITS: Record<
  MonthlyLimitKey,
  Record<PlanKey, number | null>
> = {
  ai_grading_reports: {
    starter: 5,
    collector: 5,
    pro: null,
  },
  regrade_arbitrage_views: {
    starter: 15,
    collector: 15,
    pro: null,
  },
};

// ─── Persistent (non-monthly) limits ────────────────────────────────────────

// price_alerts renamed watchlist_items (Phase 1 gate 4) — the limit was
// never actually the count of *alerts*; buyBelowPrice/sellAbovePrice are
// optional columns on a watchlist_items row, not a separate resource (see
// watchlist.service.ts), so "watchlist + price alerts: 5 cards" (§7) is
// one combined cap on watchlist row count. The old name collided in
// meaning (not in code — just confusingly) with the unrelated
// notify_price_alerts notification-preference boolean elsewhere in this
// codebase. submissions added here (see the MonthlyLimitKey comment above
// for why it moved from monthly to static).
export type StaticLimitKey =
  | "collections"
  | "master_sets"
  | "watchlist_items"
  | "submissions";

// Same Free-tier-numbers-for-both-legacy-paid-tiers caveat as
// MONTHLY_LIMITS above applies to master_sets/watchlist_items/submissions.
const STATIC_LIMITS: Record<StaticLimitKey, Record<PlanKey, number | null>> = {
  collections: {
    starter: 1,
    collector: 1,
    pro: 3,
  },
  master_sets: {
    starter: 5,
    collector: 5,
    pro: null,
  },
  watchlist_items: {
    starter: 5,
    collector: 5,
    pro: null,
  },
  submissions: {
    starter: 5,
    collector: 5,
    pro: null,
  },
};

// ─── Source-table mapping for monthly counting ──────────────────────────────
// We count actual rows in the source table rather than maintaining a separate
// usage counter — accurate, simple, no drift.

const MONTHLY_SOURCES: Record<
  MonthlyLimitKey,
  { table: string; userColumn: string; dateColumn: string } | null
> = {
  ai_grading_reports: {
    table: "ai_grading_reports",
    userColumn: "user_id",
    dateColumn: "created_at",
  },
  // Real source as of Phase 1 gate 4 (migrations/2026-08-29_regrade_arbitrage_checks.sql)
  // — was null ("cap is informational") before this; the cap is now
  // actually enforced. Rows are written server-side, synchronously, inside
  // GET /grading/arbitrage's controller for non-Pro requests only — see
  // gradingArbitrage.service.ts.
  regrade_arbitrage_views: {
    table: "regrade_arbitrage_checks",
    userColumn: "user_id",
    dateColumn: "created_at",
  },
};

// ─── Errors ─────────────────────────────────────────────────────────────────

export interface PlanError extends Error {
  status: number;
  code: string;
  upgradeTo?: PlanKey;
  limit?: number;
  current?: number;
}

const planError = (
  message: string,
  code: string,
  upgradeTo?: PlanKey,
  extra: Partial<PlanError> = {},
): PlanError =>
  Object.assign(new Error(message), {
    status: 403,
    code,
    upgradeTo,
    ...extra,
  }) as PlanError;

// ─── Plan resolution ────────────────────────────────────────────────────────

export interface ResolvedPlan {
  plan: PlanKey;
  effectivePlan: PlanKey; // 'pro' for admins regardless of subscription
  isAdmin: boolean;
  platform: string | null;
}

/**
 * Returns the user's plan tier. Admins always resolve to 'pro' for
 * enforcement purposes. The actual stored plan is returned in `plan` so
 * billing and analytics see the true subscription.
 */
export const resolvePlan = async (
  userId: string,
  role: string | null = null,
): Promise<ResolvedPlan> => {
  const isAdmin = role === "admin";

  // Fetch ALL active subscriptions across platforms.
  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status, platform, trial_ends_at, current_period_end")
    .eq("user_id", userId)
    .in("status", ["active", "trialing"]);

  // Comp grants (vendor codes / admin) expire by date — there's no store
  // webhook to flip them, so we date-check them here and drop expired ones to
  // free. Store subscriptions (apple/android/web) stay status-managed.
  const now = Date.now();
  const rows = (data ?? []).filter((row: any) => {
    if (row.platform === "comp") {
      const end = row.trial_ends_at ?? row.current_period_end;
      if (end && new Date(end).getTime() < now) return false; // expired
    }
    return true;
  });

  // Pick the highest-ranked active plan, and remember its platform.
  let plan: PlanKey = "starter";
  let platform: string | null = null;
  for (const row of rows) {
    const candidate = row.plan as PlanKey;
    if (PLAN_RANK[candidate] > PLAN_RANK[plan]) {
      plan = candidate;
      platform = (row.platform as string) ?? null;
    }
  }

  return {
    plan,
    effectivePlan: isAdmin ? "pro" : plan,
    isAdmin,
    platform, // null when starter / no active subscription
  };
};

// ─── Feature gates ──────────────────────────────────────────────────────────

export const hasFeature = async (
  userId: string,
  feature: FeatureKey,
  role: string | null = null,
): Promise<boolean> => {
  const { effectivePlan } = await resolvePlan(userId, role);
  return PLAN_RANK[effectivePlan] >= PLAN_RANK[FEATURE_MIN_PLAN[feature]];
};

export const requireFeature = async (
  userId: string,
  feature: FeatureKey,
  role: string | null = null,
): Promise<void> => {
  const { effectivePlan } = await resolvePlan(userId, role);
  const required = FEATURE_MIN_PLAN[feature];
  if (PLAN_RANK[effectivePlan] < PLAN_RANK[required]) {
    throw planError(
      `This feature requires the ${cap(required)} plan or higher.`,
      "PLAN_FEATURE_LOCKED",
      required,
    );
  }
};

// ─── Monthly limit checks ───────────────────────────────────────────────────

const monthStart = (): string => {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1),
  ).toISOString();
};

export interface UsageInfo {
  used: number;
  limit: number | null; // null = unlimited
  remaining: number | null; // null = unlimited
}

/**
 * Count how many of this resource the user has used this calendar month.
 */
export const getMonthlyUsage = async (
  userId: string,
  key: MonthlyLimitKey,
): Promise<number> => {
  const source = MONTHLY_SOURCES[key];
  if (!source) return 0;

  const { count } = await supabaseAdmin
    .from(source.table)
    .select("id", { count: "exact", head: true })
    .eq(source.userColumn, userId)
    .gte(source.dateColumn, monthStart());

  return count ?? 0;
};

/**
 * Get usage + limit + remaining for a given monthly resource.
 */
export const getMonthlyLimitInfo = async (
  userId: string,
  key: MonthlyLimitKey,
  role: string | null = null,
): Promise<UsageInfo> => {
  const { effectivePlan } = await resolvePlan(userId, role);
  const limit = MONTHLY_LIMITS[key][effectivePlan];
  const used = await getMonthlyUsage(userId, key);
  return {
    used,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - used),
  };
};

/**
 * Throws PlanError if the user has hit the monthly cap for this resource.
 * Pass `costOfThisRequest` when a single request consumes more than 1
 * (e.g. creating a submission with 13 cards — pass 1 since the SUBMISSION
 * counts as one, not the cards).
 */
export const checkMonthlyLimit = async (
  userId: string,
  key: MonthlyLimitKey,
  role: string | null = null,
  costOfThisRequest = 1,
): Promise<void> => {
  const { effectivePlan } = await resolvePlan(userId, role);
  const limit = MONTHLY_LIMITS[key][effectivePlan];
  if (limit === null) return; // unlimited

  if (limit === 0) {
    // Hard block at this tier — direct the user to upgrade
    const minPlan = lowestPlanWithLimit(key);
    throw planError(
      `Your plan doesn't include ${friendlyName(key)}. Upgrade to ${cap(minPlan)} to access it.`,
      "PLAN_FEATURE_LOCKED",
      minPlan,
      { limit: 0, current: 0 },
    );
  }

  const used = await getMonthlyUsage(userId, key);
  if (used + costOfThisRequest > limit) {
    const nextPlan = nextHigherPlan(effectivePlan);
    throw planError(
      `You've used ${used} of ${limit} ${friendlyName(key)} this month.${
        nextPlan
          ? ` Upgrade to ${cap(nextPlan)} for ${nextPlan === "pro" ? "unlimited" : "more"}.`
          : ""
      }`,
      "PLAN_LIMIT_REACHED",
      nextPlan ?? undefined,
      { limit, current: used },
    );
  }
};

// ─── Static limits (used by collection & master-set services) ──────────────

export const getStaticLimit = async (
  userId: string,
  key: StaticLimitKey,
  role: string | null = null,
): Promise<number | null> => {
  const { effectivePlan } = await resolvePlan(userId, role);
  return STATIC_LIMITS[key][effectivePlan];
};

// ─── Aggregated plan info for the frontend ─────────────────────────────────

/**
 * One call from the frontend on app load → returns everything the UI needs
 * to decide what to show / lock / display as "X/100 used".
 */
export const getPlanSnapshot = async (
  userId: string,
  role: string | null = null,
) => {
  const resolved = await resolvePlan(userId, role);

  // Feature flags are resolved alongside usage, but MUST NOT be able to
  // break this endpoint. /me/plan runs on app boot for every user on both
  // platforms — if flag resolution threw, the snapshot would 500 and the
  // whole app would fall back to DEFAULT_FEATURES (everything locked, for
  // everyone). Degrade to "no flags" instead: dark features stay dark, the
  // app keeps working.
  //
  // Phase 1 gate 5: regrade_arbitrage_views joins ai_grading_reports here
  // (both monthly, both go through getMonthlyLimitInfo — no gate-4-vs-5
  // distinction left, arbitrage's enforcement AND its counter ship
  // together now). masterSets/watchlistItems/submissions current-counts
  // are plain COUNT queries run directly here rather than importing
  // masterSet.service.ts::canTrackMoreSets / watchlist.service.ts::
  // canAddMoreToWatchlist / gradingLifecycle.service.ts::
  // canCreateMoreSubmissions — all three of those already import FROM this
  // file (getStaticLimit, resolvePlan), so importing them back in here
  // would be circular. Three extra short queries, not a shared helper —
  // same "no drift, but not DRY" trade-off this file's own
  // getMonthlyUsage() comment already accepts for the monthly side.
  const [aiGrading, arbitrage, masterSetsCount, watchlistCount, submissionsCount, flags] =
    await Promise.all([
      getMonthlyLimitInfo(userId, "ai_grading_reports", role),
      getMonthlyLimitInfo(userId, "regrade_arbitrage_views", role),
      supabaseAdmin
        .from("master_set_tracking")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .then((r) => r.count ?? 0),
      supabaseAdmin
        .from("watchlist_items")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .then((r) => r.count ?? 0),
      supabaseAdmin
        .from("grading_submissions")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .neq("status", "returned")
        .then((r) => r.count ?? 0),
      resolveFlagsForUser(userId, role).catch((err) => {
        console.error("[PlanService] flag resolution failed:", err);
        return {} as Record<string, boolean>;
      }),
    ]);

  // Build a features map the frontend can use as `features.portfolio_dashboard`
  const features: Record<FeatureKey, boolean> = Object.fromEntries(
    (Object.keys(FEATURE_MIN_PLAN) as FeatureKey[]).map((k) => [
      k,
      PLAN_RANK[resolved.effectivePlan] >= PLAN_RANK[FEATURE_MIN_PLAN[k]],
    ]),
  ) as Record<FeatureKey, boolean>;

  return {
    plan: resolved.plan,
    effectivePlan: resolved.effectivePlan,
    isAdmin: resolved.isAdmin,
    subscriptionPlatform: resolved.platform,
    features, // entitlement — what your PLAN includes
    flags, // rollout — what has SHIPPED to you (booleans only)
    usage: {
      aiGradingReports: aiGrading,
      regradeArbitrageViews: arbitrage,
    },
    // collections stays a bare number (unchanged, not one of gate 5's 5
    // countered surfaces) — the other three carry `current` now so the
    // client can render "N of Y" without a second request.
    staticLimits: {
      collections: STATIC_LIMITS.collections[resolved.effectivePlan],
      masterSets: {
        current: masterSetsCount,
        limit: STATIC_LIMITS.master_sets[resolved.effectivePlan],
      },
      watchlistItems: {
        current: watchlistCount,
        limit: STATIC_LIMITS.watchlist_items[resolved.effectivePlan],
      },
      submissions: {
        current: submissionsCount,
        limit: STATIC_LIMITS.submissions[resolved.effectivePlan],
      },
    },
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const friendlyName = (key: MonthlyLimitKey): string => {
  switch (key) {
    case "ai_grading_reports":
      return "AI grading reports";
    case "regrade_arbitrage_views":
      return "regrade arbitrage views";
  }
};

const nextHigherPlan = (plan: PlanKey): PlanKey | null => {
  if (plan === "starter") return "collector";
  if (plan === "collector") return "pro";
  return null;
};

const lowestPlanWithLimit = (key: MonthlyLimitKey): PlanKey => {
  const order: PlanKey[] = ["starter", "collector", "pro"];
  for (const p of order) {
    const lim = MONTHLY_LIMITS[key][p];
    if (lim === null || lim > 0) return p;
  }
  return "pro";
};

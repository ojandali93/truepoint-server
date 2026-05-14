// src/services/plan.service.ts
//
// Centralized plan/feature/limit enforcement.
// Every plan-gated endpoint imports from here. No scattered `plan === 'pro'`
// logic anywhere else.

import { supabaseAdmin } from "../lib/supabase";

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
  inventory_tracking: "collector",
  sealed_inventory: "pro",
  pack_opening: "pro",
  portfolio_dashboard: "pro",
  regrade_arbitrage: "collector",
  submission_tracking: "collector",
  ai_grading: "collector",
};

// ─── Monthly limits ─────────────────────────────────────────────────────────
// `null` = unlimited. `0` = blocked (use FEATURE_MIN_PLAN instead, but kept
// here as a safety net).

export type MonthlyLimitKey =
  | "ai_grading_reports"
  | "submissions"
  | "regrade_arbitrage_views";

const MONTHLY_LIMITS: Record<
  MonthlyLimitKey,
  Record<PlanKey, number | null>
> = {
  ai_grading_reports: {
    starter: 0,
    collector: 100,
    pro: null,
  },
  submissions: {
    starter: 0,
    collector: 4,
    pro: null,
  },
  regrade_arbitrage_views: {
    starter: 0,
    collector: 50,
    pro: null,
  },
};

// ─── Persistent (non-monthly) limits ────────────────────────────────────────

export type StaticLimitKey = "collections" | "master_sets" | "price_alerts";

const STATIC_LIMITS: Record<StaticLimitKey, Record<PlanKey, number | null>> = {
  collections: {
    starter: 1,
    collector: 1,
    pro: 3,
  },
  master_sets: {
    starter: 3,
    collector: null,
    pro: null,
  },
  price_alerts: {
    starter: 0,
    collector: 10,
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
  submissions: {
    table: "grading_submissions",
    userColumn: "user_id",
    dateColumn: "created_at",
  },
  // No source table yet for arbitrage views — would need a usage table.
  // Returning null means count = 0 always, so the cap is informational.
  regrade_arbitrage_views: null,
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

  const { data } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status")
    .eq("user_id", userId)
    .in("status", ["active", "trialing"])
    .maybeSingle();

  const plan = (data?.plan as PlanKey) ?? "starter";
  return {
    plan,
    effectivePlan: isAdmin ? "pro" : plan,
    isAdmin,
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

  const [aiGrading, submissions] = await Promise.all([
    getMonthlyLimitInfo(userId, "ai_grading_reports", role),
    getMonthlyLimitInfo(userId, "submissions", role),
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
    features,
    usage: {
      aiGradingReports: aiGrading,
      submissions,
    },
    staticLimits: {
      collections: STATIC_LIMITS.collections[resolved.effectivePlan],
      masterSets: STATIC_LIMITS.master_sets[resolved.effectivePlan],
      priceAlerts: STATIC_LIMITS.price_alerts[resolved.effectivePlan],
    },
  };
};

// ─── Helpers ────────────────────────────────────────────────────────────────

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

const friendlyName = (key: MonthlyLimitKey): string => {
  switch (key) {
    case "ai_grading_reports":
      return "AI grading reports";
    case "submissions":
      return "grading submissions";
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

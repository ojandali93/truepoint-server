// src/services/adminPlatform.service.ts
// All platform management operations for the admin dashboard.
// Covers: error logs, activity logs, user management,
//         feature flags, grading costs, app settings.

import { supabaseAdmin } from "../lib/supabase";
import {
  FLAG_COLUMNS,
  FlagAudience,
  invalidateFlagCache,
} from "./featureFlag.service";

// ─── Error Logs ───────────────────────────────────────────────────────────────

export interface ErrorLogFilters {
  severity?: "warning" | "error" | "critical";
  source?: string;
  resolved?: boolean;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export const getErrorLogs = async (filters: ErrorLogFilters = {}) => {
  // NOTE: this previously used PostgREST embedded joins
  //   user:profiles!user_id(...), resolver:profiles!resolved_by(...)
  // which require declared FKs from error_logs → profiles. If those FKs don't
  // exist, PostgREST throws and the endpoint returns nothing — which is why the
  // admin Error Logs tab came back empty. We now select plain columns (always
  // safe) and hydrate the profile names in a second query.
  let q = supabaseAdmin
    .from("error_logs")
    .select(
      `
      id, created_at, severity, source, message, stack_trace,
      request_path, request_method, metadata, resolved, resolved_at,
      resolution_note, user_id, resolved_by
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.severity) q = q.eq("severity", filters.severity);
  if (filters.source) q = q.eq("source", filters.source);
  if (filters.resolved !== undefined) q = q.eq("resolved", filters.resolved);
  if (filters.fromDate) q = q.gte("created_at", filters.fromDate);
  if (filters.toDate) q = q.lte("created_at", filters.toDate);

  q = q.range(
    filters.offset ?? 0,
    (filters.offset ?? 0) + (filters.limit ?? 50) - 1,
  );

  const { data, error, count } = await q;
  if (error) throw error;

  const rows = data ?? [];

  // Hydrate the user + resolver profiles (best-effort — a missing profile must
  // never blank out the whole log list).
  const ids = Array.from(
    new Set(
      rows
        .flatMap((r: any) => [r.user_id, r.resolved_by])
        .filter((v): v is string => !!v),
    ),
  );

  let byId = new Map<string, any>();
  if (ids.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, username, full_name")
      .in("id", ids);
    byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
  }

  const logs = rows.map((r: any) => ({
    ...r,
    user: r.user_id ? (byId.get(r.user_id) ?? null) : null,
    resolver: r.resolved_by ? (byId.get(r.resolved_by) ?? null) : null,
  }));

  return { logs, total: count ?? 0 };
};

export const resolveErrorLog = async (
  id: string,
  resolvedBy: string,
  note?: string,
) => {
  const { error } = await supabaseAdmin
    .from("error_logs")
    .update({
      resolved: true,
      resolved_at: new Date().toISOString(),
      resolved_by: resolvedBy,
      resolution_note: note ?? null,
    })
    .eq("id", id);
  if (error) throw error;
};

export const getErrorLogSummary = async () => {
  const { data } = await supabaseAdmin
    .from("error_logs")
    .select("severity, resolved")
    .gte(
      "created_at",
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    );

  const counts = { critical: 0, error: 0, warning: 0, unresolved: 0 };
  for (const row of data ?? []) {
    if (row.severity === "critical") counts.critical++;
    if (row.severity === "error") counts.error++;
    if (row.severity === "warning") counts.warning++;
    if (!row.resolved) counts.unresolved++;
  }
  return counts;
};

// ─── Activity Logs ────────────────────────────────────────────────────────────

export interface ActivityLogFilters {
  userId?: string;
  action?: string;
  resourceType?: string;
  fromDate?: string;
  toDate?: string;
  limit?: number;
  offset?: number;
}

export const getActivityLogs = async (filters: ActivityLogFilters = {}) => {
  // Same fix as getErrorLogs: avoid the PostgREST embedded join
  // (user:profiles!user_id) which silently breaks the endpoint when the FK
  // isn't declared. Select plain columns, then hydrate the profiles.
  let q = supabaseAdmin
    .from("activity_logs")
    .select(
      `
      id, created_at, action, resource_type, resource_id,
      metadata, ip_address, duration_ms, user_id
    `,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.userId) q = q.eq("user_id", filters.userId);
  if (filters.action) q = q.ilike("action", `%${filters.action}%`);
  if (filters.resourceType) q = q.eq("resource_type", filters.resourceType);
  if (filters.fromDate) q = q.gte("created_at", filters.fromDate);
  if (filters.toDate) q = q.lte("created_at", filters.toDate);

  q = q.range(
    filters.offset ?? 0,
    (filters.offset ?? 0) + (filters.limit ?? 50) - 1,
  );

  const { data, error, count } = await q;
  if (error) throw error;

  const rows = data ?? [];
  const ids = Array.from(
    new Set(rows.map((r: any) => r.user_id).filter((v): v is string => !!v)),
  );

  let byId = new Map<string, any>();
  if (ids.length > 0) {
    const { data: profiles } = await supabaseAdmin
      .from("profiles")
      .select("id, username, full_name")
      .in("id", ids);
    byId = new Map((profiles ?? []).map((p: any) => [p.id, p]));
  }

  const logs = rows.map((r: any) => ({
    ...r,
    user: r.user_id ? (byId.get(r.user_id) ?? null) : null,
  }));

  return { logs, total: count ?? 0 };
};

// ─── User Management ──────────────────────────────────────────────────────────

export interface UserListFilters {
  search?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}

export const getUsers = async (filters: UserListFilters = {}) => {
  // subscriptions FK points to auth.users not profiles, so we can't auto-join.
  // Query profiles + subscriptions + devices separately, merge by user_id in JS.
  let q = supabaseAdmin
    .from("profiles")
    .select("id, username, full_name, created_at, email_verified", {
      count: "exact",
    })
    .order("created_at", { ascending: false });

  if (filters.search) {
    q = q.or(
      `username.ilike.%${filters.search}%,full_name.ilike.%${filters.search}%`,
    );
  }

  q = q.range(
    filters.offset ?? 0,
    (filters.offset ?? 0) + (filters.limit ?? 50) - 1,
  );

  const { data: profiles, error, count } = await q;
  if (error) throw error;
  if (!profiles?.length) return { users: [], total: count ?? 0 };

  const ids = profiles.map((p) => p.id);

  // Subscriptions
  const { data: subs } = await supabaseAdmin
    .from("subscriptions")
    .select("user_id, plan, status, current_period_end")
    .in("user_id", ids);
  const subMap = new Map((subs ?? []).map((s) => [s.user_id, s]));

  // Last login = most recent last_login_at across the user's devices.
  // (login/page.tsx + mobile both register a device on login.)
  const { data: devices } = await supabaseAdmin
    .from("user_devices")
    .select("user_id, last_login_at")
    .in("user_id", ids);
  const lastLoginMap = new Map<string, string>();
  for (const d of devices ?? []) {
    if (!d.last_login_at) continue;
    const prev = lastLoginMap.get(d.user_id);
    // ISO timestamps compare correctly as strings
    if (!prev || d.last_login_at > prev) {
      lastLoginMap.set(d.user_id, d.last_login_at);
    }
  }

  const users = profiles.map((p) => ({
    ...p,
    email_verified: p.email_verified ?? false,
    last_login_at: lastLoginMap.get(p.id) ?? null,
    subscription: subMap.has(p.id) ? [subMap.get(p.id)] : [],
  }));

  return { users, total: count ?? 0 };
};

export const getUserById = async (userId: string) => {
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, username, full_name, created_at")
    .eq("id", userId)
    .single();
  if (error) throw error;

  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, status, current_period_end, stripe_customer_id")
    .eq("user_id", userId)
    .maybeSingle();

  const { count: inventoryCount } = await supabaseAdmin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const { count: gradingCount } = await supabaseAdmin
    .from("grading_submissions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  const { count: aiGradingCount } = await supabaseAdmin
    .from("ai_grading_reports")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);

  return {
    profile,
    subscription: sub ?? null,
    stats: {
      inventoryItems: inventoryCount ?? 0,
      gradingSubmissions: gradingCount ?? 0,
      aiGradingReports: aiGradingCount ?? 0,
    },
  };
};

// Rich per-user snapshot for the admin user-detail modal:
// full profile + subscription + live collection valuation + feature usage
// counts + recent device/login activity.
export const getUserDetail = async (userId: string) => {
  // Full profile
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select(
      `id, username, full_name, avatar_url, phone, currency,
       preferred_grading_company, show_market_values,
       favorite_pokemon, favorite_set, collecting_years,
       collection_type, collector_style,
       email_verified, email_verified_at,
       affiliation, affiliation_id,
       created_at, updated_at`,
    )
    .eq("id", userId)
    .single();
  if (error) throw error;

  // Subscription (may not exist for free users)
  const { data: subscription } = await supabaseAdmin
    .from("subscriptions")
    .select(
      `plan, status, platform, trial_ends_at, current_period_end,
       created_at, stripe_customer_id, rc_app_user_id`,
    )
    .eq("user_id", userId)
    .maybeSingle();

  // Linked affiliate (if the user is themselves an affiliate / was attributed)
  let affiliate: {
    id: string;
    name: string;
    slug: string | null;
    type: string;
    status: string;
  } | null = null;
  if (profile?.affiliation_id) {
    const { data: aff } = await supabaseAdmin
      .from("affiliates")
      .select("id, name, slug, type, status")
      .eq("id", profile.affiliation_id)
      .maybeSingle();
    affiliate = aff ?? null;
  }

  // Live inventory valuation + item breakdown. Reuses the exact same price
  // resolution the user sees in their own inventory, so the value here matches
  // what they see (and is accurate now that bulk price fetches are paginated).
  let inventory: {
    totalCards: number;
    rawCards: number;
    gradedCards: number;
    sealedProducts: number;
    marketValue: number;
    costBasis: number;
    gainLoss: number;
  } | null = null;
  try {
    const { getInventory } = await import("./inventory.service");
    const { summary } = await getInventory(userId, null);
    inventory = {
      totalCards: summary.totalItems,
      rawCards: summary.rawCards,
      gradedCards: summary.gradedCards,
      sealedProducts: summary.sealedProducts,
      marketValue: summary.totalMarketValue,
      costBasis: summary.totalCostBasis,
      gainLoss: summary.totalGainLoss,
    };
  } catch (e) {
    console.error("[AdminPlatform] getUserDetail inventory error:", e);
    inventory = null; // UI shows "unavailable" rather than a wrong number
  }

  // Feature-usage + tracking counts (parallel, head-only counts)
  const countFor = async (table: string, col = "user_id"): Promise<number> => {
    const { count, error: cErr } = await supabaseAdmin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq(col, userId);
    if (cErr) {
      console.error(`[AdminPlatform] count ${table} error:`, cErr.message);
      return 0;
    }
    return count ?? 0;
  };

  const [
    collectionsCount,
    masterSetsTracked,
    centeringReports,
    aiGradingReports,
    gradingSubmissions,
    ebayReports,
    feedbackSubmitted,
    errorLogs,
    deviceCount,
  ] = await Promise.all([
    countFor("collections"),
    countFor("master_set_tracking"),
    countFor("centering_reports"),
    countFor("ai_grading_reports"),
    countFor("grading_submissions"),
    countFor("ebay_analysis_reports"),
    countFor("feedback"),
    countFor("error_logs"),
    countFor("user_devices"),
  ]);

  // Recent devices + last login (ordered desc, so the first row is the latest)
  const { data: devices } = await supabaseAdmin
    .from("user_devices")
    .select(
      "device_type, device_name, os, browser, push_provider, last_login_at, last_seen, is_active",
    )
    .eq("user_id", userId)
    .order("last_login_at", { ascending: false, nullsFirst: false })
    .limit(5);

  const lastLoginAt = devices?.[0]?.last_login_at ?? null;

  return {
    profile,
    subscription: subscription ?? null,
    affiliate,
    inventory,
    usage: {
      collections: collectionsCount,
      masterSetsTracked,
      centeringReports,
      aiGradingReports,
      gradingSubmissions,
      ebayReports,
      feedbackSubmitted,
      errorLogs,
    },
    activity: {
      lastLoginAt,
      deviceCount,
      recentDevices: devices ?? [],
    },
  };
};

// ─── Part B: admin user drill-down (AI grading / centering reports, ───────────
// ─── read-only collection, golden-set flagging) ────────────────────────────────

/**
 * AI grading reports for one user, list view — mirrors the shape
 * getReports() (aiGrading.controller.ts) returns for the user's own
 * GET /grading/ai-reports, minus the submission_cards join (not needed for
 * the admin list row: date, card, predicted grades). Capped at 100 —
 * this is an admin drill-down, not a paginated surface; a user with more
 * than 100 AI grading reports is not a case this v1 handles.
 */
export const getUserAIGradingReports = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("ai_grading_reports")
    .select(
      "id, card_name, set_name, status, overall_score, tp_score, recommendation, created_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
};

/**
 * One AI grading report, full detail — every column (photos, subgrades,
 * predictions, findings text), same as the user's own report view sees,
 * plus this report's flag state (null if never flagged). Filters on BOTH
 * reportId and userId — defense in depth, so the admin drill-down can
 * never cross-link into a different user's report even if a reportId is
 * guessed/mistyped in the URL.
 */
export const getUserAIGradingReportDetail = async (
  userId: string,
  reportId: string,
) => {
  const { data: report, error } = await supabaseAdmin
    .from("ai_grading_reports")
    .select("*")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!report) return null;

  const flag = await getReportFlag(reportId, "ai_grading");
  return { report, flag };
};

/** Centering reports for one user, list view. Same 100-row cap reasoning
 *  as getUserAIGradingReports. */
export const getUserCenteringReports = async (userId: string) => {
  const { data, error } = await supabaseAdmin
    .from("centering_reports")
    .select(
      "id, card_id, side, label, truepoint_score, psa_grade, worst_axis, created_at",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
};

/** One centering report, full detail (image + every measurement/grade
 *  column) + flag state. Same userId+reportId double-filter as the AI
 *  grading detail above. */
export const getUserCenteringReportDetail = async (
  userId: string,
  reportId: string,
) => {
  const { data: report, error } = await supabaseAdmin
    .from("centering_reports")
    .select("*")
    .eq("id", reportId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!report) return null;

  const flag = await getReportFlag(reportId, "centering");
  return { report, flag };
};

/** Read-only inventory list for the admin drill-down's Collection section.
 *  Reuses inventory.service's getInventory() exactly as getUserDetail
 *  above already does for the summary-only view -- same live price
 *  resolution, just also returning the item rows this time. */
export const getUserCollection = async (userId: string) => {
  const { getInventory } = await import("./inventory.service");
  const { items, summary } = await getInventory(userId, null);
  return { items, summary };
};

// ─── Golden-set flagging (admin_flagged_reports) ───────────────────────────────

export type FlaggableReportType = "ai_grading" | "centering";

const getReportFlag = async (reportId: string, reportType: FlaggableReportType) => {
  const { data, error } = await supabaseAdmin
    .from("admin_flagged_reports")
    .select("id, report_id, report_type, reason, flagged_by, flagged_at")
    .eq("report_id", reportId)
    .eq("report_type", reportType)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
};

/** Flag (or re-flag with a new reason) a report as a golden-set candidate.
 *  Upsert on (report_id, report_type) — see migration's unique index — so
 *  flagging an already-flagged report updates the reason/flagged_by/
 *  flagged_at rather than erroring or duplicating. */
export const flagReport = async (params: {
  reportId: string;
  reportType: FlaggableReportType;
  reason: string;
  flaggedBy: string;
}) => {
  const { data, error } = await supabaseAdmin
    .from("admin_flagged_reports")
    .upsert(
      {
        report_id: params.reportId,
        report_type: params.reportType,
        reason: params.reason,
        flagged_by: params.flaggedBy,
        flagged_at: new Date().toISOString(),
      },
      { onConflict: "report_id,report_type" },
    )
    .select("id, report_id, report_type, reason, flagged_by, flagged_at")
    .single();
  if (error) throw error;
  return data;
};

/** Unflag — removes the row entirely (not a soft-delete; the calibration
 *  harness reads live rows in this table directly, per the flag's own
 *  purpose, so a stale "flagged" row with no way to retract it would be
 *  actively misleading there). */
export const unflagReport = async (
  reportId: string,
  reportType: FlaggableReportType,
) => {
  const { error } = await supabaseAdmin
    .from("admin_flagged_reports")
    .delete()
    .eq("report_id", reportId)
    .eq("report_type", reportType);
  if (error) throw error;
};

export const updateUserPlan = async (
  userId: string,
  plan: "collector" | "pro",
  adminNote?: string,
  durationMonths?: number | null,
) => {
  // A positive duration = a time-boxed comp TRIAL (status "trialing", expires
  // at the end date). No duration = an indefinite comp grant (status "active").
  const isTrial = typeof durationMonths === "number" && durationMonths > 0;
  let endsAtIso: string | null = null;
  if (isTrial) {
    const end = new Date();
    end.setMonth(end.getMonth() + (durationMonths as number));
    endsAtIso = end.toISOString();
  }

  const fields = {
    plan,
    status: isTrial ? "trialing" : "active",
    platform: "comp", // complimentary / admin-granted (not apple/android/web)
    // referral-program-plan.md Finding 1 — 'admin_grant', always, from this
    // function going forward. 'grandfather' is reserved for the one 2026-
    // 08-29 migration batch (identified by exact row id in this migration's
    // own backfill, never assigned here) — a fresh ad-hoc admin grant isn't
    // "meant to ride alongside a real sub and disappear when it does," the
    // way that migration's grants were; it should survive
    // deactivateGrandfatherCompIfNoRealSubRemains the same way an affiliate-
    // claim or vendor-trial comp does, unless you revoke it by hand.
    comp_reason: "admin_grant",
    trial_ends_at: endsAtIso, // null for indefinite
    current_period_end: endsAtIso, // mirror so both readers agree
  };

  // Does the user already have a COMP row? platform-scoped, deliberately --
  // reusing a real stripe/apple/google row here would silently overwrite it
  // with comp/trial fields (data loss against a paying customer). Fixed
  // 2026-09-02: this exact unfiltered lookup fired 4 times against real
  // Apple subscribers (the 2026-08-29 "Phase 1 §7 grandfather" migration) --
  // that batch was a deliberate, documented decision to convert those rows,
  // not accidental corruption, and those 4 users currently have working Pro
  // access as intended; not touched by this fix. See
  // scripts/auditCompRowPlatformOverwrite.ts for the full history. Matches
  // affiliateClaim.service.ts's grantCompPro's already-safe pattern.
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .eq("platform", "comp")
    .limit(1);
  if (selErr) throw selErr;

  if (existing && existing.length > 0) {
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update(fields)
      .eq("id", existing[0].id);
    if (error) throw error;
  } else {
    // No subscription yet (the normal case for a free user). Previously this
    // path did nothing — an .update() filtered by user_id matched zero rows —
    // so admin-granted plans silently never took effect. Create the row.
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .insert({ user_id: userId, ...fields });
    if (error) throw error;
  }

  // Mark the trial as used so the app doesn't also offer its own 7-day free
  // trial when this user later subscribes through the paywall.
  await supabaseAdmin
    .from("profiles")
    .update({ trial_used: true })
    .eq("id", userId);

  // Log as admin activity
  await supabaseAdmin.from("activity_logs").insert({
    action: "admin.user.plan_override",
    resource_type: "user",
    resource_id: userId,
    metadata: {
      new_plan: plan,
      note: adminNote ?? null,
      platform: "comp",
      status: fields.status,
      trial_ends_at: endsAtIso,
      duration_months: isTrial ? durationMonths : null,
    },
  });
};

// ─── Grandfather-comp lifecycle tie-in (Phase 1 gate 7) ─────────────────────
//
// UX_OVERHAUL_PLAN.md §7 pricing migration: the 2 real subscribers active at
// migration time get a comp Pro row layered on top of their existing real
// (Apple/Google/Stripe) subscription — same mechanism updateUserPlan()
// already uses for admin/vendor-code comp grants, indefinite (no
// trial_ends_at). Ruling (Omar, this gate): "tied to the real subscription's
// lifecycle... comp-Pro deactivates when the underlying real subscription
// hits canceled/expired. Grandfathering rewards CONTINUING subscribers at
// their old price; it is not a permanent free grant that survives
// cancellation." This is that tie-in — called from every place a real
// subscription's status actually reaches a terminal state:
//   - revenuecat.service.ts's EXPIRATION case (Apple/Google)
//   - billing.service.ts's customer.subscription.deleted case (Stripe)
//
// Deliberately does NOT fire on CANCELLATION (Apple) or
// customer.subscription.updated with cancel_at_period_end set (Stripe) —
// those mean "will lapse at period end," and resolvePlan() correctly keeps
// granting access (real or comp) until the period actually ends, same
// reasoning revenuecat.service.ts's own CANCELLATION case comment gives for
// why status doesn't flip early. Only the true terminal event should cut
// the comp grant.
//
// Checks whether the user has any OTHER real (non-comp) subscription still
// active/trialing before deactivating — someone subscribed on two platforms
// at once (e.g. web then later mobile) shouldn't lose their comp grant just
// because one of the two lapsed. Subscriptions is one row per
// (user_id, platform) (upsertRevenueCatSubscription/upsertSubscription's
// onConflict), so "any remaining real row" is a complete check, not an
// approximation. Platform-agnostic by construction — the .neq("platform",
// "comp") check below counts stripe/apple/google rows identically, so
// this needed no change for Android webhook wiring.
export const deactivateGrandfatherCompIfNoRealSubRemains = async (
  userId: string,
): Promise<void> => {
  const { data: realRows, error: realErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .neq("platform", "comp")
    .in("status", ["active", "trialing"]);
  if (realErr) throw realErr;
  if (realRows && realRows.length > 0) return; // still has a real sub elsewhere

  // comp_reason='grandfather' only -- referral-program-plan.md Finding 1,
  // fixed 2026-09-02: this function's whole purpose is "a grandfathered
  // comp should disappear once the real sub it rode alongside truly ends."
  // That's never true for an affiliate-claim comp (grantCompPro's grant is
  // meant to be permanent, unconditional), a vendor-trial comp (its own
  // fixed-duration end date is what should end it, not an unrelated real
  // sub's lifecycle), or a referral-reward comp (same — its own grant
  // window is authoritative). Before this filter, ANY comp row for this
  // user would be deactivated here, regardless of why it existed —
  // confirmed via scripts/auditCompRowPlatformOverwrite.ts that this
  // exposure was real, just not yet triggered for a comp row this
  // specific deactivation path had reached.
  const { data: compRow, error: compErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id, status")
    .eq("user_id", userId)
    .eq("platform", "comp")
    .eq("comp_reason", "grandfather")
    .in("status", ["active", "trialing"])
    .maybeSingle();
  if (compErr) throw compErr;
  if (!compRow) return; // no grandfather-comp grant to deactivate

  const { error: updateErr } = await supabaseAdmin
    .from("subscriptions")
    .update({ status: "canceled", updated_at: new Date().toISOString() })
    .eq("id", compRow.id);
  if (updateErr) throw updateErr;

  await supabaseAdmin.from("activity_logs").insert({
    action: "admin.user.grandfather_comp_deactivated",
    resource_type: "user",
    resource_id: userId,
    metadata: {
      reason: "underlying real subscription reached a terminal state",
    },
  });
};

export const getUserErrorLogs = async (userId: string, limit = 20) => {
  const { data, error } = await supabaseAdmin
    .from("error_logs")
    .select("id, created_at, severity, source, message, request_path, resolved")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
};

// ─── Feature Flags ────────────────────────────────────────────────────────────
//
// Admin-side CRUD only. Runtime evaluation lives in featureFlag.service.ts —
// do not re-implement it here.
//
// The old isFeatureEnabled() that used to live in this file has been removed.
// It had zero callers and defaulted to TRUE on a missing row, which is exactly
// backwards for a system whose purpose is shipping features dark: a typo'd key
// would have exposed an unreleased feature to everyone. Use
// isFlagEnabled(key, userId, role) from featureFlag.service.ts instead.

export const getFeatureFlags = async () => {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select(FLAG_COLUMNS)
    .order("key");
  if (error) throw error;
  return data ?? [];
};

export interface FeatureFlagPatch {
  enabled?: boolean;
  audience?: FlagAudience;
  allowed_user_ids?: string[];
  rollout_percentage?: number;
  description?: string | null;
}

/**
 * Partial update of one flag. Only the keys present in `patch` are written,
 * so toggling `enabled` never clobbers an allowlist.
 *
 * Returns null when the key doesn't exist — the controller turns that into a
 * 404 rather than silently creating a half-configured flag (the previous
 * implementation upserted, so a typo'd key created a new row with a null
 * description).
 */
export const updateFeatureFlagConfig = async (
  key: string,
  patch: FeatureFlagPatch,
  updatedBy: string | null,
) => {
  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: updatedBy,
  };

  if (patch.enabled !== undefined) update.enabled = patch.enabled;
  if (patch.audience !== undefined) update.audience = patch.audience;
  if (patch.allowed_user_ids !== undefined)
    update.allowed_user_ids = patch.allowed_user_ids;
  if (patch.rollout_percentage !== undefined)
    update.rollout_percentage = patch.rollout_percentage;
  if (patch.description !== undefined) update.description = patch.description;

  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .update(update)
    .eq("key", key)
    .select(FLAG_COLUMNS)
    .maybeSingle();

  if (error) throw error;

  invalidateFlagCache();
  return data ?? null;
};

/**
 * Create a flag. Always born dark: enabled=true but audience='off' means the
 * kill switch is armed and nobody can see it until an audience is chosen.
 */
export const createFeatureFlag = async (
  key: string,
  description: string | null,
  createdBy: string | null,
) => {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .insert({
      key,
      description,
      enabled: true,
      audience: "off",
      allowed_user_ids: [],
      rollout_percentage: 0,
      updated_by: createdBy,
    })
    .select(FLAG_COLUMNS)
    .single();

  if (error) throw error;

  invalidateFlagCache();
  return data;
};

export const deleteFeatureFlag = async (key: string) => {
  const { error } = await supabaseAdmin
    .from("feature_flags")
    .delete()
    .eq("key", key);
  if (error) throw error;

  invalidateFlagCache();
};

// ─── Grading Costs ────────────────────────────────────────────────────────────

export const getGradingCosts = async () => {
  const { data, error } = await supabaseAdmin
    .from("grading_costs")
    .select("id, company, tier, cost_usd, turnaround, updated_at")
    .order("company")
    .order("cost_usd");
  if (error) throw error;
  return data ?? [];
};

export const updateGradingCost = async (
  id: string,
  costUsd: number,
  turnaround?: string,
) => {
  const { error } = await supabaseAdmin
    .from("grading_costs")
    .update({
      cost_usd: costUsd,
      turnaround: turnaround ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
};

// Get costs as a nested object for use in arbitrage calculations
// Returns: { PSA: { standard: 25, express: 75 }, BGS: { ... }, ... }
export const getGradingCostsMap = async (): Promise<
  Record<string, Record<string, number>>
> => {
  const costs = await getGradingCosts();
  const map: Record<string, Record<string, number>> = {};
  for (const c of costs) {
    if (!map[c.company]) map[c.company] = {};
    map[c.company][c.tier] = Number(c.cost_usd);
  }
  return map;
};

// ─── App Settings ─────────────────────────────────────────────────────────────

export const getAppSettings = async () => {
  const { data, error } = await supabaseAdmin
    .from("app_settings")
    .select("key, value, description, updated_at")
    .order("key");
  if (error) throw error;
  return data ?? [];
};

export const getAppSetting = async (key: string): Promise<unknown> => {
  const { data } = await supabaseAdmin
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .single();
  return data?.value ?? null;
};

export const updateAppSetting = async (
  key: string,
  value: unknown,
  updatedBy: string,
) => {
  const { error } = await supabaseAdmin.from("app_settings").upsert(
    {
      key,
      value,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" },
  );
  if (error) throw error;
};

// ─── Platform Stats ───────────────────────────────────────────────────────────
// Quick snapshot for admin dashboard overview card

export const getPlatformStats = async () => {
  const [
    { count: totalUsers },
    { count: proUsers },
    { count: totalCards },
    { count: totalSubmissions },
    { count: totalAiReports },
    errorSummary,
  ] = await Promise.all([
    supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("subscriptions")
      .select("id", { count: "exact", head: true })
      .eq("plan", "pro")
      .eq("status", "active"),
    supabaseAdmin
      .from("inventory")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("grading_submissions")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("ai_grading_reports")
      .select("id", { count: "exact", head: true }),
    getErrorLogSummary(),
  ]);

  return {
    totalUsers: totalUsers ?? 0,
    proUsers: proUsers ?? 0,
    totalCards: totalCards ?? 0,
    totalSubmissions: totalSubmissions ?? 0,
    totalAiReports: totalAiReports ?? 0,
    errors: errorSummary,
  };
};

/**
 * Delete error logs older than `retainDays` (default 14). Backs the nightly
 * cron so the table doesn't grow without bound and the admin view stays useful.
 */
export const purgeOldErrorLogs = async (retainDays = 14) => {
  const cutoff = new Date(
    Date.now() - retainDays * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { error, count } = await supabaseAdmin
    .from("error_logs")
    .delete({ count: "exact" })
    .lt("created_at", cutoff);
  if (error) throw error;
  return { deleted: count ?? 0, cutoff, retainDays };
};

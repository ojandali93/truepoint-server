// src/services/adminPlatform.service.ts
// All platform management operations for the admin dashboard.
// Covers: error logs, activity logs, user management,
//         feature flags, grading costs, app settings.

import { supabaseAdmin } from "../lib/supabase";

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
    trial_ends_at: endsAtIso, // null for indefinite
    current_period_end: endsAtIso, // mirror so both readers agree
  };

  // Does the user already have a subscription row?
  const { data: existing, error: selErr } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
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

export const getFeatureFlags = async () => {
  const { data, error } = await supabaseAdmin
    .from("feature_flags")
    .select("id, key, enabled, description, metadata, updated_at")
    .order("key");
  if (error) throw error;
  return data ?? [];
};

export const setFeatureFlag = async (
  key: string,
  enabled: boolean,
  updatedBy: string,
) => {
  const { error } = await supabaseAdmin.from("feature_flags").upsert(
    {
      key,
      enabled,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "key" },
  );
  if (error) throw error;
};

// Check a single flag — use this in route handlers to gate features
export const isFeatureEnabled = async (key: string): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("feature_flags")
    .select("enabled")
    .eq("key", key)
    .single();
  return data?.enabled ?? true; // default to enabled if flag doesn't exist
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

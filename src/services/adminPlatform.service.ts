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
  let q = supabaseAdmin
    .from("error_logs")
    .select(
      `
      id, created_at, severity, source, message, stack_trace,
      request_path, request_method, metadata, resolved, resolved_at, resolution_note,
      user:profiles!user_id(id, username, full_name),
      resolver:profiles!resolved_by(id, username, full_name)
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
  return { logs: data ?? [], total: count ?? 0 };
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
  let q = supabaseAdmin
    .from("activity_logs")
    .select(
      `
      id, created_at, action, resource_type, resource_id,
      metadata, ip_address, duration_ms,
      user:profiles!user_id(id, username, full_name)
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
  return { logs: data ?? [], total: count ?? 0 };
};

// ─── User Management ──────────────────────────────────────────────────────────

export interface UserListFilters {
  search?: string;
  plan?: string;
  limit?: number;
  offset?: number;
}

export const getUsers = async (filters: UserListFilters = {}) => {
  let q = supabaseAdmin
    .from("profiles")
    .select(
      `
      id, username, full_name, created_at,
      subscription:subscriptions(plan, status, current_period_end)
    `,
      { count: "exact" },
    )
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

  const { data, error, count } = await q;
  if (error) throw error;
  return { users: data ?? [], total: count ?? 0 };
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

export const updateUserPlan = async (
  userId: string,
  plan: "collector" | "pro",
  adminNote?: string,
) => {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ plan, status: "active" })
    .eq("user_id", userId);
  if (error) throw error;

  // Log as admin activity
  await supabaseAdmin.from("activity_logs").insert({
    action: "admin.user.plan_override",
    resource_type: "user",
    resource_id: userId,
    metadata: { new_plan: plan, note: adminNote ?? null },
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
  const { error } = await supabaseAdmin
    .from("feature_flags")
    .upsert(
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

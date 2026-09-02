// src/controllers/adminPlatform.controller.ts
// All admin platform management endpoints.
// Every route requires admin role (enforced in admin.routes.ts via requireAdmin).

import { Request, Response } from "express";
import {
  getErrorLogs,
  resolveErrorLog,
  getErrorLogSummary,
  getActivityLogs,
  getUsers,
  getUserById,
  getUserDetail as getUserDetailService,
  updateUserPlan,
  getUserErrorLogs,
  getFeatureFlags,
  updateFeatureFlagConfig,
  createFeatureFlag as createFeatureFlagService,
  deleteFeatureFlag as deleteFeatureFlagService,
  FeatureFlagPatch,
  getGradingCosts,
  updateGradingCost,
  getAppSettings,
  updateAppSetting,
  getPlatformStats,
  getUserAIGradingReports,
  getUserAIGradingReportDetail,
  getUserCenteringReports,
  getUserCenteringReportDetail,
  getUserCollection,
  flagReport,
  unflagReport,
  type FlaggableReportType,
} from "../services/adminPlatform.service";
import { logError } from "../lib/Logger";
import { FLAG_AUDIENCES, FlagAudience } from "../services/featureFlag.service";
import { KNOWN_FLAGS } from "../constants/featureFlagKeys";
import { supabaseAdmin } from "../lib/supabase";
import { sendPushToUsers } from "../services/push.service";
import { AuthenticatedRequest } from "../types/user.types";
import {
  fetchCardByTcgplayerId,
  extractGradedPrices,
} from "../lib/poketraceClient";

import {
  fetchAndCacheGradedPrices,
  getGradedPricesForCard,
} from "../services/poketracePriceSync.service";
import {
  getVerificationStatus,
  sendVerificationEmail,
} from "../lib/emailVerification";

const handle = (res: Response, err: unknown) => {
  const msg = err instanceof Error ? err.message : "Admin operation failed";
  console.error("[AdminPlatform]", err);
  res.status(500).json({ error: msg });
};

// ─── Platform overview ────────────────────────────────────────────────────────

export const platformStats = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const stats = await getPlatformStats();
    res.json({ data: stats });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Error logs ───────────────────────────────────────────────────────────────

// GET /admin/logs/errors?severity=&source=&resolved=&fromDate=&toDate=&limit=&offset=
export const listErrorLogs = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { severity, source, fromDate, toDate } = req.query as Record<
      string,
      string
    >;
    const resolved =
      req.query.resolved === "true"
        ? true
        : req.query.resolved === "false"
          ? false
          : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);

    const result = await getErrorLogs({
      severity: severity as any,
      source,
      resolved,
      fromDate,
      toDate,
      limit,
      offset,
    });
    res.json({ data: result });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/logs/errors/summary
export const errorLogSummary = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const summary = await getErrorLogSummary();
    res.json({ data: summary });
  } catch (err) {
    handle(res, err);
  }
};

// PATCH /admin/logs/errors/:id/resolve
export const resolveError = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const adminId = (req as AuthenticatedRequest).user?.id ?? null;
    const { note } = req.body;
    await resolveErrorLog(req.params.id, adminId, note);
    res.json({ data: { resolved: true } });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Activity logs ────────────────────────────────────────────────────────────

// GET /admin/logs/activity?userId=&action=&resourceType=&fromDate=&toDate=&limit=&offset=
export const listActivityLogs = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { userId, action, resourceType, fromDate, toDate } =
      req.query as Record<string, string>;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);

    const result = await getActivityLogs({
      userId,
      action,
      resourceType,
      fromDate,
      toDate,
      limit,
      offset,
    });
    res.json({ data: result });
  } catch (err) {
    handle(res, err);
  }
};

// ─── User management ──────────────────────────────────────────────────────────

// GET /admin/users?search=&plan=&limit=&offset=
export const listUsers = async (req: Request, res: Response): Promise<void> => {
  try {
    const { search, plan } = req.query as Record<string, string>;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);

    const result = await getUsers({ search, plan, limit, offset });
    res.json({ data: result });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId
export const getUser = async (req: Request, res: Response): Promise<void> => {
  try {
    const user = await getUserById(req.params.userId);
    res.json({ data: user });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/detail
// Full admin snapshot: profile + subscription + live collection valuation +
// feature-usage counts + recent device/login activity.
export const getUserDetailHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const detail = await getUserDetailService(req.params.userId);
    res.json({ data: detail });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/errors
export const getUserErrors = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const logs = await getUserErrorLogs(req.params.userId, limit);
    res.json({ data: logs });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Part B: admin user drill-down ─────────────────────────────────────────────

// GET /admin/users/:userId/ai-grading-reports
export const listUserAIGradingReports = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const reports = await getUserAIGradingReports(req.params.userId);
    res.json({ data: reports });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/ai-grading-reports/:reportId
export const getUserAIGradingReportHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const detail = await getUserAIGradingReportDetail(
      req.params.userId,
      req.params.reportId,
    );
    if (!detail) {
      res.status(404).json({ error: "Report not found for this user." });
      return;
    }
    res.json({ data: detail });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/centering-reports
export const listUserCenteringReports = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const reports = await getUserCenteringReports(req.params.userId);
    res.json({ data: reports });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/centering-reports/:reportId
export const getUserCenteringReportHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const detail = await getUserCenteringReportDetail(
      req.params.userId,
      req.params.reportId,
    );
    if (!detail) {
      res.status(404).json({ error: "Report not found for this user." });
      return;
    }
    res.json({ data: detail });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/users/:userId/collection
export const getUserCollectionHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const collection = await getUserCollection(req.params.userId);
    res.json({ data: collection });
  } catch (err) {
    handle(res, err);
  }
};

const FLAGGABLE_TYPES: FlaggableReportType[] = ["ai_grading", "centering"];

// POST /admin/flagged-reports
// Body: { reportId: uuid, reportType: 'ai_grading' | 'centering', reason: string }
export const flagReportHandler = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { reportId, reportType, reason } = req.body ?? {};
    if (typeof reportId !== "string" || !reportId) {
      res.status(400).json({ error: "reportId is required." });
      return;
    }
    if (!FLAGGABLE_TYPES.includes(reportType)) {
      res
        .status(400)
        .json({ error: "reportType must be 'ai_grading' or 'centering'." });
      return;
    }
    if (typeof reason !== "string" || !reason.trim()) {
      res.status(400).json({ error: "reason is required." });
      return;
    }
    const flag = await flagReport({
      reportId,
      reportType,
      reason: reason.trim(),
      flaggedBy: req.user!.id,
    });
    res.json({ data: flag });
  } catch (err) {
    handle(res, err);
  }
};

// DELETE /admin/flagged-reports/:reportType/:reportId
export const unflagReportHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { reportType, reportId } = req.params;
    if (!FLAGGABLE_TYPES.includes(reportType as FlaggableReportType)) {
      res
        .status(400)
        .json({ error: "reportType must be 'ai_grading' or 'centering'." });
      return;
    }
    await unflagReport(reportId, reportType as FlaggableReportType);
    res.json({ data: { ok: true } });
  } catch (err) {
    handle(res, err);
  }
};

// PATCH /admin/users/:userId/plan
// Body: { plan: 'collector' | 'pro', note?: string, durationMonths?: number }
//   durationMonths > 0  → time-boxed comp trial (status "trialing", auto-expires)
//   omitted / 0 / null  → indefinite comp grant (status "active")
export const overrideUserPlan = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { plan, note, durationMonths } = req.body;
    if (!["collector", "pro"].includes(plan)) {
      res
        .status(400)
        .json({ error: "Invalid plan. Must be collector or pro." });
      return;
    }
    const months =
      durationMonths === undefined || durationMonths === null
        ? null
        : Number(durationMonths);
    if (months !== null && (!Number.isFinite(months) || months < 0)) {
      res
        .status(400)
        .json({ error: "durationMonths must be a positive number." });
      return;
    }
    await updateUserPlan(req.params.userId, plan, note, months);
    res.json({ data: { updated: true, plan, durationMonths: months } });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Feature flags ────────────────────────────────────────────────────────────

// GET /admin/flags
export const listFeatureFlags = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const flags = await getFeatureFlags();
    res.json({ data: flags });
  } catch (err) {
    handle(res, err);
  }
};

// GET /admin/flags/known-keys
//
// Suggestions for the "create flag" form — every key a useFlag()/
// requireFlag() call site in the codebase actually checks for, sourced from
// server/src/constants/featureFlagKeys.ts. Not a hard constraint: the admin
// UI still accepts a free-typed key for a flag whose code doesn't exist
// yet (the normal build order is flag first, code second). This just
// removes the guesswork for the common case of connecting a flag to a
// feature that's already been built.
export const listKnownFlagKeys = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  res.json({ data: KNOWN_FLAGS });
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Flag keys become code identifiers (useFlag("my_flag")), so keep them tame.
const FLAG_KEY_RE = /^[a-z][a-z0-9_]{2,63}$/;

// PATCH /admin/flags/:key
// Body: any subset of
//   { enabled, audience, allowed_user_ids, rollout_percentage, description }
export const updateFeatureFlag = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const adminId = (req as AuthenticatedRequest).user?.id ?? null;
    const body = req.body ?? {};
    const patch: FeatureFlagPatch = {};

    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        res.status(400).json({ error: "enabled must be a boolean" });
        return;
      }
      patch.enabled = body.enabled;
    }

    if (body.audience !== undefined) {
      if (!FLAG_AUDIENCES.includes(body.audience as FlagAudience)) {
        res.status(400).json({
          error: `audience must be one of: ${FLAG_AUDIENCES.join(", ")}`,
        });
        return;
      }
      patch.audience = body.audience as FlagAudience;
    }

    if (body.allowed_user_ids !== undefined) {
      if (!Array.isArray(body.allowed_user_ids)) {
        res.status(400).json({ error: "allowed_user_ids must be an array" });
        return;
      }
      const ids = body.allowed_user_ids.map((v: unknown) => String(v).trim());
      const bad = ids.find((id: string) => !UUID_RE.test(id));
      if (bad) {
        res.status(400).json({ error: `Not a valid user id: ${bad}` });
        return;
      }
      patch.allowed_user_ids = Array.from(new Set(ids));
    }

    if (body.rollout_percentage !== undefined) {
      const pct = Number(body.rollout_percentage);
      if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
        res
          .status(400)
          .json({ error: "rollout_percentage must be an integer 0–100" });
        return;
      }
      patch.rollout_percentage = pct;
    }

    if (body.description !== undefined) {
      patch.description =
        body.description === null ? null : String(body.description);
    }

    if (Object.keys(patch).length === 0) {
      res.status(400).json({ error: "No updatable fields supplied" });
      return;
    }

    const updated = await updateFeatureFlagConfig(
      req.params.key,
      patch,
      adminId,
    );

    // No upsert here on purpose — a PATCH to a typo'd key used to silently
    // create a half-configured flag. Use POST /admin/flags to create.
    if (!updated) {
      res.status(404).json({ error: `No flag with key "${req.params.key}"` });
      return;
    }

    res.json({ data: updated });
  } catch (err) {
    handle(res, err);
  }
};

// POST /admin/flags
// Body: { key: string, description?: string }
export const createFeatureFlag = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const adminId = (req as AuthenticatedRequest).user?.id ?? null;
    const key = String(req.body?.key ?? "")
      .trim()
      .toLowerCase();

    if (!FLAG_KEY_RE.test(key)) {
      res.status(400).json({
        error:
          "key must be 3–64 chars, lowercase letters/numbers/underscores, starting with a letter",
      });
      return;
    }

    const description =
      req.body?.description === undefined || req.body?.description === null
        ? null
        : String(req.body.description);

    const created = await createFeatureFlagService(key, description, adminId);
    res.status(201).json({ data: created });
  } catch (err) {
    // 23505 = unique_violation on feature_flags.key
    if ((err as { code?: string })?.code === "23505") {
      res.status(409).json({ error: "A flag with that key already exists" });
      return;
    }
    handle(res, err);
  }
};

// DELETE /admin/flags/:key
export const deleteFeatureFlag = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    await deleteFeatureFlagService(req.params.key);
    res.json({ data: { deleted: true, key: req.params.key } });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Grading costs ────────────────────────────────────────────────────────────

// GET /admin/grading-costs
export const listGradingCosts = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const costs = await getGradingCosts();
    res.json({ data: costs });
  } catch (err) {
    handle(res, err);
  }
};

// PATCH /admin/grading-costs/:id
// Body: { costUsd: number, turnaround?: string }
export const updateCost = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { costUsd, turnaround } = req.body;
    if (!costUsd || isNaN(Number(costUsd))) {
      res.status(400).json({ error: "costUsd must be a number" });
      return;
    }
    await updateGradingCost(req.params.id, Number(costUsd), turnaround);
    res.json({ data: { updated: true } });
  } catch (err) {
    handle(res, err);
  }
};

// ─── App settings ─────────────────────────────────────────────────────────────

// GET /admin/settings
export const listAppSettings = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const settings = await getAppSettings();
    res.json({ data: settings });
  } catch (err) {
    handle(res, err);
  }
};

// PATCH /admin/settings/:key
// Body: { value: any }
export const updateSetting = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const adminId = (req as AuthenticatedRequest).user?.id ?? null;
    const { value } = req.body;
    if (value === undefined) {
      res.status(400).json({ error: "value is required" });
      return;
    }
    await updateAppSetting(req.params.key, value, adminId);
    res.json({ data: { updated: true, key: req.params.key } });
  } catch (err) {
    handle(res, err);
  }
};

export const broadcastNotification = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const title =
      typeof req.body?.title === "string" ? req.body.title.trim() : "";
    const body = typeof req.body?.body === "string" ? req.body.body.trim() : "";

    if (!title || !body) {
      res.status(400).json({ error: "title and body are required" });
      return;
    }
    if (title.length > 100 || body.length > 240) {
      res.status(400).json({ error: "title ≤ 100 chars, body ≤ 240 chars" });
      return;
    }

    // Every distinct user with a push token.
    const { data, error } = await supabaseAdmin
      .from("user_devices")
      .select("user_id")
      .not("device_token", "is", null);
    if (error) throw error;

    const userIds = Array.from(
      new Set((data ?? []).map((r: any) => r.user_id as string)),
    ).filter(Boolean);

    if (userIds.length === 0) {
      res.json({
        data: { recipients: 0, sent: 0, message: "No devices to notify." },
      });
      return;
    }

    const result = await sendPushToUsers(userIds, {
      title,
      body,
      data: { type: "broadcast" },
    });

    res.json({
      data: {
        recipients: userIds.length,
        sent: result.sent,
        failed: result.failed,
        message: `Sent to ${result.sent} of ${userIds.length} users.`,
      },
    });
  } catch (err: any) {
    await logError({
      source: "admin-broadcast",
      message: err?.message ?? "Broadcast failed",
      error: err,
      userId: (req as any)?.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
    });
    res.status(500).json({ error: err?.message });
  }
};

const DIAGNOSTIC_CARD_ID = "42382";

export interface DiagnosticStep {
  id: string;
  label: string;
  status: "ok" | "fail";
  value?: string;
  error?: string;
  elapsedMs?: number;
}

// GET /admin/diagnostics/poketrace
//
// Returns an array of step results. The screen renders each as green/red.
// Admin-only (admin.routes already enforces requireAdmin).
export const runPoketraceDiagnostics = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  const steps: DiagnosticStep[] = [];
  const t0 = Date.now();

  const tick = (_label?: string): number => Date.now();

  // ─── Step 1: env config ───────────────────────────────────────────────────
  {
    const start = tick("env");
    const hasKey = !!process.env.POKETRACE_RAPIDAPI_KEY;
    const host =
      process.env.POKETRACE_RAPIDAPI_HOST ?? "poketrace-api.p.rapidapi.com";
    steps.push({
      id: "env",
      label: "1. Environment configuration",
      status: hasKey ? "ok" : "fail",
      value: hasKey ? `host: ${host}` : undefined,
      error: hasKey
        ? undefined
        : "POKETRACE_RAPIDAPI_KEY not set in Render env vars",
      elapsedMs: Date.now() - start,
    });
    if (!hasKey) {
      res.json({
        data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
      });
      return;
    }
  }

  // ─── Step 2: known-card lookup against your DB ────────────────────────────
  {
    const start = tick("db");
    try {
      const { data, error } = await supabaseAdmin
        .from("cards")
        .select("id, name, set_id")
        .eq("id", DIAGNOSTIC_CARD_ID)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        steps.push({
          id: "db",
          label: "2. Test card in your database",
          status: "fail",
          error: `Card ${DIAGNOSTIC_CARD_ID} (Base Set Charizard) not found in cards table — your catalog may be incomplete`,
          elapsedMs: Date.now() - start,
        });
        res.json({
          data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
        });
        return;
      }
      steps.push({
        id: "db",
        label: "2. Test card in your database",
        status: "ok",
        value: `${data.name} (id=${data.id})`,
        elapsedMs: Date.now() - start,
      });
    } catch (err: any) {
      steps.push({
        id: "db",
        label: "2. Test card in your database",
        status: "fail",
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - start,
      });
      res.json({
        data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
      });
      return;
    }
  }

  // ─── Step 3: live PokeTrace API fetch ─────────────────────────────────────
  let poketraceCard: any = null;
  {
    const start = tick("api");
    try {
      poketraceCard = await fetchCardByTcgplayerId(DIAGNOSTIC_CARD_ID);
      if (!poketraceCard) {
        steps.push({
          id: "api",
          label: "3. PokeTrace API live fetch",
          status: "fail",
          error: `PokeTrace returned no card for tcgplayerId=${DIAGNOSTIC_CARD_ID}`,
          elapsedMs: Date.now() - start,
        });
        res.json({
          data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
        });
        return;
      }
      steps.push({
        id: "api",
        label: "3. PokeTrace API live fetch",
        status: "ok",
        value: `${poketraceCard.name} — ${poketraceCard.set?.name ?? "?"}`,
        elapsedMs: Date.now() - start,
      });
    } catch (err: any) {
      const msg = err?.response?.data
        ? JSON.stringify(err.response.data)
        : (err?.message ?? String(err));
      steps.push({
        id: "api",
        label: "3. PokeTrace API live fetch",
        status: "fail",
        error: `HTTP error: ${msg}`,
        elapsedMs: Date.now() - start,
      });
      res.json({
        data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
      });
      return;
    }
  }

  // ─── Step 4: graded-data extraction ──────────────────────────────────────
  let gradedCount = 0;
  let companies: string[] = [];
  {
    const start = tick("graded");
    try {
      const graded = extractGradedPrices(poketraceCard);
      gradedCount = graded.length;
      companies = Array.from(new Set(graded.map((g) => g.company)));
      steps.push({
        id: "graded",
        label: "4. Graded-data extraction",
        status: gradedCount > 0 ? "ok" : "fail",
        value:
          gradedCount > 0
            ? `${gradedCount} grade entries across ${companies.join(", ")}`
            : undefined,
        error:
          gradedCount > 0
            ? undefined
            : "PokeTrace returned the card but no graded prices — Pro plan may not be active",
        elapsedMs: Date.now() - start,
      });
      if (gradedCount === 0) {
        res.json({
          data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
        });
        return;
      }
    } catch (err: any) {
      steps.push({
        id: "graded",
        label: "4. Graded-data extraction",
        status: "fail",
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - start,
      });
      res.json({
        data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
      });
      return;
    }
  }

  // ─── Step 5: cache write — verify market_prices got rows ─────────────────
  {
    const start = tick("write");
    try {
      // Trigger the actual cache write by calling the sync path
      await fetchAndCacheGradedPrices(DIAGNOSTIC_CARD_ID);
      const { data, error } = await supabaseAdmin
        .from("market_prices")
        .select("grade")
        .eq("card_id", DIAGNOSTIC_CARD_ID)
        .eq("source", "poketrace");
      if (error) throw error;
      const rowCount = data?.length ?? 0;
      steps.push({
        id: "write",
        label: "5. Cache write (market_prices rows)",
        status: rowCount > 0 ? "ok" : "fail",
        value: rowCount > 0 ? `${rowCount} rows in market_prices` : undefined,
        error:
          rowCount > 0
            ? undefined
            : "No poketrace rows in market_prices for this card after sync",
        elapsedMs: Date.now() - start,
      });
      if (rowCount === 0) {
        res.json({
          data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
        });
        return;
      }
    } catch (err: any) {
      steps.push({
        id: "write",
        label: "5. Cache write (market_prices rows)",
        status: "fail",
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - start,
      });
      res.json({
        data: { steps, overall: "fail", elapsedMs: Date.now() - t0 },
      });
      return;
    }
  }

  // ─── Step 6: cache read — verify the read helper returns correct shape ───
  {
    const start = tick("read");
    try {
      const prices = await getGradedPricesForCard(DIAGNOSTIC_CARD_ID);
      const psaCount = prices.filter((p) => p.company === "PSA").length;
      const bgsCount = prices.filter((p) => p.company === "BGS").length;
      const cgcCount = prices.filter((p) => p.company === "CGC").length;
      steps.push({
        id: "read",
        label: "6. Cache read (final shape for UI)",
        status: prices.length > 0 ? "ok" : "fail",
        value:
          prices.length > 0
            ? `PSA: ${psaCount}, BGS: ${bgsCount}, CGC: ${cgcCount} grades`
            : undefined,
        error: prices.length > 0 ? undefined : "Read helper returned 0 prices",
        elapsedMs: Date.now() - start,
      });
    } catch (err: any) {
      steps.push({
        id: "read",
        label: "6. Cache read (final shape for UI)",
        status: "fail",
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - start,
      });
    }
  }

  // ─── Step 7: bulk-sync inventory count (info only) ───────────────────────
  {
    const start = tick("inv");
    try {
      const { data, error } = await supabaseAdmin
        .from("inventory")
        .select("card_id")
        .not("card_id", "is", null);
      if (error) throw error;
      const distinct = new Set((data ?? []).map((r: any) => r.card_id)).size;
      steps.push({
        id: "inv",
        label: "7. Inventory cards eligible for daily sync",
        status: "ok",
        value: `${distinct} distinct cards across all users`,
        elapsedMs: Date.now() - start,
      });
    } catch (err: any) {
      steps.push({
        id: "inv",
        label: "7. Inventory cards eligible for daily sync",
        status: "fail",
        error: err?.message ?? String(err),
        elapsedMs: Date.now() - start,
      });
    }
  }

  const overall = steps.every((s) => s.status === "ok") ? "ok" : "fail";
  res.json({ data: { steps, overall, elapsedMs: Date.now() - t0 } });
};

// POST /admin/users/:userId/resend-verification
// Admin-triggered resend of the verification email to a specific user.
// Skips already-verified users; bypasses the 60s user-facing cooldown.
export const resendUserVerification = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { userId } = req.params;

    // Already verified → nothing to send.
    const status = await getVerificationStatus(userId);
    if (status.emailVerified) {
      res.json({ data: { sent: false, alreadyVerified: true } });
      return;
    }

    // Resolve the user's email from Supabase auth.
    const { data: authData, error } =
      await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !authData?.user?.email) {
      res.status(404).json({ error: "User email not found" });
      return;
    }

    const result = await sendVerificationEmail(userId, authData.user.email);
    res.json({
      data: {
        sent: result.sent,
        alreadyVerified: false,
        email: authData.user.email,
      },
    });
  } catch (err) {
    handle(res, err);
  }
};

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
  updateUserPlan,
  getUserErrorLogs,
  getFeatureFlags,
  setFeatureFlag,
  getGradingCosts,
  updateGradingCost,
  getAppSettings,
  updateAppSetting,
  getPlatformStats,
} from "../services/adminPlatform.service";

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
    const adminId = (req as any).userId;
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

// PATCH /admin/users/:userId/plan
// Body: { plan: 'collector' | 'pro', note?: string }
export const overrideUserPlan = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { plan, note } = req.body;
    if (!["collector", "pro"].includes(plan)) {
      res
        .status(400)
        .json({ error: "Invalid plan. Must be collector or pro." });
      return;
    }
    await updateUserPlan(req.params.userId, plan, note);
    res.json({ data: { updated: true, plan } });
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

// PATCH /admin/flags/:key
// Body: { enabled: boolean }
export const updateFeatureFlag = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const adminId = (req as any).userId;
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled must be a boolean" });
      return;
    }
    await setFeatureFlag(req.params.key, enabled, adminId);
    res.json({ data: { updated: true, key: req.params.key, enabled } });
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
    const adminId = (req as any).userId;
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

// src/routes/admin.routes.ts

import { Router } from "express";

// ─── Existing admin controllers ───────────────────────────────────────────────
import {
  getUserStats,
  getCollectionStats,
  getSetAnalytics,
} from "../services/adminAnalytics.service";
import {
  getSetRules,
  saveSetVariants,
} from "../controllers/variant.controller";

// ─── New platform management controllers ──────────────────────────────────────
import {
  platformStats,
  listErrorLogs,
  errorLogSummary,
  resolveError,
  listActivityLogs,
  listUsers,
  getUser,
  getUserErrors,
  overrideUserPlan,
  listFeatureFlags,
  updateFeatureFlag,
  listGradingCosts,
  updateCost,
  listAppSettings,
  updateSetting,
} from "../controllers/adminPlatform.controller";

const router = Router();

import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
router.use(authenticateUser as any, requireAdmin as any);

// ─── Overview ─────────────────────────────────────────────────────────────────
router.get("/stats", platformStats as any);

// ─── Analytics (existing) ─────────────────────────────────────────────────────
router.get("/analytics/users", getUserStats as any);
router.get("/analytics/collection", getCollectionStats as any);
router.get("/analytics/sets", getSetAnalytics as any);

// ─── Error logs ───────────────────────────────────────────────────────────────
router.get("/logs/errors/summary", errorLogSummary as any);
router.get("/logs/errors", listErrorLogs as any);
router.patch("/logs/errors/:id/resolve", resolveError as any);

// ─── Activity logs ────────────────────────────────────────────────────────────
router.get("/logs/activity", listActivityLogs as any);

// ─── User management ──────────────────────────────────────────────────────────
router.get("/users", listUsers as any);
router.get("/users/:userId", getUser as any);
router.get("/users/:userId/errors", getUserErrors as any);
router.patch("/users/:userId/plan", overrideUserPlan as any);

// ─── Feature flags ────────────────────────────────────────────────────────────
router.get("/flags", listFeatureFlags as any);
router.patch("/flags/:key", updateFeatureFlag as any);

// ─── Grading costs ────────────────────────────────────────────────────────────
router.get("/grading-costs", listGradingCosts as any);
router.patch("/grading-costs/:id", updateCost as any);

// ─── App settings ─────────────────────────────────────────────────────────────
router.get("/settings", listAppSettings as any);
router.patch("/settings/:key", updateSetting as any);

// ─── Variants (existing) ──────────────────────────────────────────────────────
router.get("/variants", getSetRules as any);
router.post("/variants", saveSetVariants as any);

export default router;

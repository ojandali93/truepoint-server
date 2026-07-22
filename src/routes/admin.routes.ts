// src/routes/admin.routes.ts

import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import {
  adminListCodes,
  adminCreateCode,
  adminSetCodeActive,
  adminDeleteCode,
} from "../controllers/adminVendorCode.controller";

// ─── Analytics controller (wraps service functions as Express handlers) ───────
import {
  getUserAnalytics,
  getCollectionAnalytics,
  getSetAnalyticsHandler,
} from "../controllers/adminAnalytics.controller";

// ─── Variant controller ───────────────────────────────────────────────────────
import {
  getSetRules,
  saveSetVariants,
} from "../controllers/variant.controller";

// ─── Platform management controller ──────────────────────────────────────────
import {
  platformStats,
  listErrorLogs,
  errorLogSummary,
  resolveError,
  listActivityLogs,
  listUsers,
  getUser,
  getUserDetailHandler,
  getUserErrors,
  overrideUserPlan,
  listFeatureFlags,
  updateFeatureFlag,
  listGradingCosts,
  updateCost,
  listAppSettings,
  updateSetting,
  broadcastNotification,
  runPoketraceDiagnostics,
  resendUserVerification,
} from "../controllers/adminPlatform.controller";

const router = Router();

// Auth + admin check on every admin route
router.use(authenticateUser as any, requireAdmin as any);

router.get("/codes", adminListCodes as any);
router.post("/codes", adminCreateCode as any);
router.patch("/codes/:id", adminSetCodeActive as any);
router.delete("/codes/:id", adminDeleteCode as any);

// ─── Overview ─────────────────────────────────────────────────────────────────
router.get("/stats", platformStats as any);

// ─── Analytics ────────────────────────────────────────────────────────────────
router.get("/analytics/users", getUserAnalytics as any);
router.get("/analytics/collection", getCollectionAnalytics as any);
router.get("/analytics/sets", getSetAnalyticsHandler as any);

// ─── Error logs ───────────────────────────────────────────────────────────────
router.get("/logs/errors/summary", errorLogSummary as any);
router.get("/logs/errors", listErrorLogs as any);
router.patch("/logs/errors/:id/resolve", resolveError as any);

// ─── Activity logs ────────────────────────────────────────────────────────────
router.get("/logs/activity", listActivityLogs as any);

// ─── User management ──────────────────────────────────────────────────────────
router.get("/users", listUsers as any);
router.get("/users/:userId/detail", getUserDetailHandler as any);
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

// ─── Variants ─────────────────────────────────────────────────────────────────
router.get("/variants", getSetRules as any);
router.post("/variants", saveSetVariants as any);

router.post("/broadcast", broadcastNotification as any);
router.get("/diagnostics/poketrace", runPoketraceDiagnostics as any);

router.post(
  "/users/:userId/resend-verification",
  resendUserVerification as any,
);

export default router;

// src/routes/plan.routes.ts

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import { getMyPlan } from "../controllers/plan.controller";

const router = Router();

// Apply authentication as per-route middleware (NOT router.use) so it
// doesn't run for requests that fall through to siblings also mounted at
// /api/v1 (like auth.routes.ts). Express applies router-level middleware
// to every request matching the mount path regardless of whether a handler
// in that router actually matches the URL.
router.get(
  "/me/plan",
  authenticateUser as any,
  standardLimiter,
  getMyPlan as any,
);

export default router;

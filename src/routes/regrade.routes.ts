// src/routes/regrade.routes.ts
//
// Everything here is gated behind the "regrade_tracker" flag — create it in
// admin → Feature Flags and allowlist the tester account before any of
// these routes will respond with real data. Until then every one returns
// 404, indistinguishable from a route that doesn't exist yet.

import { Router } from "express";

import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import { requireFlagMiddleware } from "../middleware/flag.middleware";
import * as RegradeController from "../controllers/regradeTracker.controller";

const router = Router();
router.use(authenticateUser as any);
router.use(requireFlagMiddleware("regrade_tracker") as any);

// GET /api/v1/regrades/:cardId/ladder
// Price at every known grade+company for ANY card — no ownership required.
router.get(
  "/:cardId/ladder",
  standardLimiter,
  RegradeController.getLadder as any,
);

// GET /api/v1/regrades
// The current user's tracked (unowned) regrade candidates.
router.get("/", standardLimiter, RegradeController.listTracked as any);

// POST /api/v1/regrades
router.post("/", standardLimiter, RegradeController.createTracked as any);

// PATCH /api/v1/regrades/:id
router.patch("/:id", standardLimiter, RegradeController.updateTracked as any);

// DELETE /api/v1/regrades/:id
router.delete("/:id", standardLimiter, RegradeController.deleteTracked as any);

export default router;

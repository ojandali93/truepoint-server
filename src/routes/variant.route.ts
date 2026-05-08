// src/routes/variant.routes.ts
import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import {
  standardLimiter,
  adminLimiter,
} from "../middleware/rateLimit.middleware";
import * as VariantController from "../controllers/variant.controller";

const router = Router();

router.use(authenticateUser as any);

// ─── Public (all authenticated users) ────────────────────────────────────────

// GET /api/v1/variants/sets/:setId/status
router.get(
  "/sets/:setId/status",
  standardLimiter,
  VariantController.getSetStatus as any,
);

// GET /api/v1/variants/sets/:setId
router.get(
  "/sets/:setId",
  standardLimiter,
  VariantController.getSetVariants as any,
);

// GET /api/v1/variants/sets/:setId/cards
// Returns all cards for a set with variants embedded — used by open product modal
router.get(
  "/sets/:setId/cards",
  standardLimiter,
  VariantController.getCardsWithVariants as any,
);

// ─── Admin only ───────────────────────────────────────────────────────────────

// GET /api/v1/variants/sets/:setId/rules  (admin view)
router.get(
  "/sets/:setId/rules",
  adminLimiter,
  requireAdmin as any,
  VariantController.getSetRules as any,
);

// POST /api/v1/variants/sets/:setId/save
router.post(
  "/sets/:setId/save",
  adminLimiter,
  requireAdmin as any,
  VariantController.saveSetVariants as any,
);

export default router;

import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
  adminLimiter,
} from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  identifyFromBase64Schema,
  identifyFromUrlSchema,
} from "../schemas/card.schemas";
import * as CardController from "../controllers/card.controller";

const router = Router();

router.use(authenticateUser as any);

// ─── Sets ──────────────────────────────────────────────────────────────────────
router.get("/sets", standardLimiter, CardController.getAllSets as any);
router.get("/sets/:setId", standardLimiter, CardController.getSetById as any);
router.get(
  "/sets/:setId/cards",
  standardLimiter,
  CardController.getCardsBySet as any,
);

// ─── Cards ─────────────────────────────────────────────────────────────────────
router.get("/search", standardLimiter, CardController.searchCards as any);
router.get(
  "/:cardId/prices",
  standardLimiter,
  CardController.getCardPrices as any,
);
router.get("/:cardId", standardLimiter, CardController.getCardById as any);

// ─── Sealed Products ───────────────────────────────────────────────────────────
router.get(
  "/sealed/:setCode",
  standardLimiter,
  CardController.getSealedProductPrices as any,
);

// ─── Card Identification ───────────────────────────────────────────────────────
router.post(
  "/identify/base64",
  writeLimiter,
  validate(identifyFromBase64Schema),
  CardController.identifyCardFromBase64 as any,
);
router.post(
  "/identify/url",
  writeLimiter,
  validate(identifyFromUrlSchema),
  CardController.identifyCardFromUrl as any,
);

// ─── Admin ─────────────────────────────────────────────────────────────────────
router.post(
  "/admin/sync/sets",
  adminLimiter,
  requireAdmin as any,
  CardController.adminSyncSets as any,
);
router.post(
  "/admin/sync/cards",
  adminLimiter,
  requireAdmin as any,
  CardController.adminBackfillCards as any,
);
router.get(
  "/admin/sync/status",
  adminLimiter,
  requireAdmin as any,
  CardController.adminGetSyncStatus as any,
);
router.post(
  "/admin/sync/sets/:setId",
  adminLimiter,
  requireAdmin as any,
  CardController.adminSyncSingleSet as any,
);
router.delete(
  "/admin/prices/expired",
  adminLimiter,
  requireAdmin as any,
  CardController.adminPurgeExpiredPrices as any,
);

export default router;

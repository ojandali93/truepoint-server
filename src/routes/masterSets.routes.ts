// src/routes/masterSet.routes.ts

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as MC from "../controllers/masterSet.controller";

const router = Router();
router.use(authenticateUser as any);

// GET  /api/v1/master-sets              — all tracked sets with progress
router.get("/", standardLimiter, MC.getTracked as any);

// GET  /api/v1/master-sets/limit         — plan limit info
router.get("/limit", standardLimiter, MC.getLimit as any);

// GET  /api/v1/master-sets/:setId        — full card list with collection status
router.get("/:setId", standardLimiter, MC.getSetDetail as any);

// POST /api/v1/master-sets/:setId/track  — start tracking a set
router.post("/:setId/track", writeLimiter, MC.startTracking as any);

// DELETE /api/v1/master-sets/:setId/track — stop tracking a set
router.delete("/:setId/track", writeLimiter, MC.stopTracking as any);

// POST /api/v1/master-sets/:setId/cards/:cardId/toggle — mark/unmark a card variant
router.post(
  "/:setId/cards/:cardId/toggle",
  writeLimiter,
  MC.toggleCardCollected as any,
);

// PUT  /api/v1/master-sets/:setId/cards/:cardId/quantity — set quantity (dupes)
router.put(
  "/:setId/cards/:cardId/quantity",
  writeLimiter,
  MC.setCardQuantity as any,
);

export default router;

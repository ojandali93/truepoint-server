import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as MC from "../controllers/masterSet.controller";

const router = Router();
router.use(authenticateUser as any);

router.get("/", standardLimiter, MC.getTracked as any);
router.get("/limit", standardLimiter, MC.getLimit as any);
router.get("/:setId", standardLimiter, MC.getSetDetail as any);
router.post("/:setId/track", writeLimiter, MC.startTracking as any);
router.delete("/:setId/track", writeLimiter, MC.stopTracking as any);
router.post(
  "/:setId/cards/:cardId/toggle",
  writeLimiter,
  MC.toggleCardCollected as any,
);
router.put(
  "/:setId/cards/:cardId/quantity",
  writeLimiter,
  MC.setCardQuantity as any,
);

export default router;

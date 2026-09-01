import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as CS from "../controllers/counterfeitScreening.controller";

const router = Router();
router.use(authenticateUser as any);

router.post("/screen", writeLimiter, CS.screenCard as any);
router.get("/reports", standardLimiter, CS.getReports as any);
router.delete("/reports/:id", writeLimiter, CS.deleteReport as any);

export default router;

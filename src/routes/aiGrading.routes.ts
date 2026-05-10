import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as AIG from "../controllers/aiGrading.controller";

const router = Router();
router.use(authenticateUser as any);

router.post("/ai-analyze", writeLimiter, AIG.analyzeCard as any);
router.get("/ai-reports", standardLimiter, AIG.getReports as any);
router.delete("/ai-reports/:id", writeLimiter, AIG.deleteReport as any);

export default router;

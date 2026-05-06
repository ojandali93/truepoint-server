import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  analyzeCenteringSchema,
  saveCenteringReportSchema,
} from "../schemas/centering.schemas";
import * as CenteringController from "../controllers/centering.controller";

const router = Router();

router.use(authenticateUser as any);

// Live calculation — no DB write, called repeatedly as user drags lines
router.post(
  "/analyze",
  standardLimiter,
  validate(analyzeCenteringSchema),
  CenteringController.analyzeOnly as any,
);

// Final save — called once when user confirms their line positions
router.post(
  "/reports",
  writeLimiter,
  validate(saveCenteringReportSchema),
  CenteringController.analyzeAndSave as any,
);

// Report retrieval
router.get(
  "/reports",
  standardLimiter,
  CenteringController.getMyReports as any,
);
router.get(
  "/reports/:reportId",
  standardLimiter,
  CenteringController.getReportById as any,
);
router.get(
  "/reports/card/:cardId",
  standardLimiter,
  CenteringController.getReportsForCard as any,
);
router.delete(
  "/reports/:reportId",
  writeLimiter,
  CenteringController.deleteReport as any,
);

export default router;

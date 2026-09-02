// src/routes/attribution.routes.ts
//
// AUDITS/affiliate-system-plan.md §2.3 / AUDITS/referral-program-plan.md
// §2.2's shared resolver — HTTP surface. Same per-route authentication
// pattern as plan.routes.ts (router-level middleware would also apply to
// sibling routers mounted at /api/v1).

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import {
  submitMyAttribution,
  getMyReferralCode,
  getMyReferralSummary,
} from "../controllers/attribution.controller";

const router = Router();

router.post(
  "/me/attribution",
  authenticateUser as any,
  standardLimiter,
  submitMyAttribution as any,
);

router.get(
  "/me/referral-code",
  authenticateUser as any,
  standardLimiter,
  getMyReferralCode as any,
);

router.get(
  "/me/referral-summary",
  authenticateUser as any,
  standardLimiter,
  getMyReferralSummary as any,
);

export default router;

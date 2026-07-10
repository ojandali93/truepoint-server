import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  writeLimiter,
  standardLimiter,
} from "../middleware/rateLimit.middleware";
import * as VC from "../controllers/vendorCode.controller";

const router = Router();

// Public — validate a code before an account exists (pre-signup / paywall).
router.post("/validate", standardLimiter, VC.validateCode as any);

// Authenticated — actually grant the benefit.
router.use(authenticateUser as any);
router.post("/redeem", writeLimiter, VC.redeemCode as any);

export default router;

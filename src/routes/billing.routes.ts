import { Router } from "express";
import express from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  writeLimiter,
  standardLimiter,
} from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  createCheckoutSessionSchema,
  verifySessionSchema,
} from "../schemas/billing.schemas";
import * as BillingController from "../controllers/billing.controller";
import * as RevenueCatController from "../controllers/revenuecat.controller";

const router = Router();

// POST /webhook (Stripe) is NOT defined here — moved to app.ts, mounted
// standalone before the global express.json() middleware, because it
// needs the raw body for signature verification and this router is
// itself mounted after that global parser. See app.ts's EMERGENCY FIX
// 2026-08-30 comment for why a router-local express.raw() here doesn't
// work: by the time a request reaches this file, express.json() has
// already consumed the body stream. Do not re-add a /webhook route here.

router.post(
  "/revenuecat-webhook",
  express.json(),
  RevenueCatController.handleRevenueCatWebhook as any,
);

// ─── All other billing routes require auth ────────────────────────────────────
router.use(authenticateUser as any);

router.post(
  "/create-checkout-session",
  writeLimiter,
  validate(createCheckoutSessionSchema),
  BillingController.createCheckoutSession as any,
);

router.post(
  "/verify-session",
  writeLimiter,
  validate(verifySessionSchema),
  BillingController.verifySession as any,
);

router.get(
  "/subscription",
  standardLimiter,
  BillingController.getMySubscription as any,
);

router.delete(
  "/subscription",
  writeLimiter,
  BillingController.cancelMySubscription as any,
);

export default router;

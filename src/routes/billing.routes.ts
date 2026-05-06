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

const router = Router();

// ─── Webhook — raw body, no auth (Stripe signs it) ───────────────────────────
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  BillingController.handleWebhook as any,
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

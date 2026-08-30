import { z } from "zod";

export const createCheckoutSessionSchema = z.object({
  plan: z.enum(["collector", "pro"]),
  // Phase 2 pricing go-live: optional, only meaningful for plan === "pro"
  // (createCheckoutSession resolves it against STRIPE_PRO_V2_PRICE_IDS).
  // Was silently missing here — the validate() middleware does
  // `req[source] = result.data` after schema.safeParse(), and Zod's
  // default z.object() behavior strips unrecognized keys, so any
  // billingPeriod a client sent was dropped before the controller ever
  // saw it. Found while wiring the web checkout flow to actually pass it.
  billingPeriod: z.enum(["monthly", "annual"]).optional(),
});

export const verifySessionSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
});

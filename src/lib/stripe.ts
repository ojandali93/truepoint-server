import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("Missing STRIPE_SECRET_KEY environment variable");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-04-22.dahlia",
  typescript: true,
});

export const STRIPE_PRICE_IDS: Record<"collector" | "pro", string> = {
  collector: process.env.STRIPE_COLLECTOR_PRICE_ID!,
  pro: process.env.STRIPE_PRO_PRICE_ID!,
};

/**
 * Phase 1 gate 6 (UX_OVERHAUL_PLAN.md §5) — new Pro pricing: $14.99/mo ·
 * $129.99/yr, mirrors the RevenueCat pro_monthly_1499 / pro_annual_12999
 * products (revenuecat.service.ts PRODUCT_TO_PLAN). Deliberately separate
 * from STRIPE_PRICE_IDS.pro (the legacy single Pro price today's real
 * subscribers are on) rather than replacing it — createCheckoutSession
 * only reads this when called with an explicit billingPeriod, so existing
 * checkout behavior is unchanged until the web pricing UI is built to pass
 * one. Real price IDs supplied 2026-08-29; not independently verified
 * against Stripe's dashboard amount (only a live-mode key can read them —
 * the local dev key is sk_test_, which can't see live objects at all, so
 * a lookup here would misleadingly 404 rather than actually check
 * anything). Order matters — do not swap monthly/annual.
 */
export const STRIPE_PRO_V2_PRICE_IDS: Record<"monthly" | "annual", string> = {
  monthly: process.env.STRIPE_PRO_MONTHLY_PRICE_ID!,
  annual: process.env.STRIPE_PRO_ANNUAL_PRICE_ID!,
};

export const PLAN_NAMES = {
  collector: "Collector",
  pro: "Pro",
} as const;

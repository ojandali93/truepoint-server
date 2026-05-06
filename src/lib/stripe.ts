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

export const PLAN_NAMES = {
  collector: "Collector",
  pro: "Pro",
} as const;

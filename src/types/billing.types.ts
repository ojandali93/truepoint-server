export interface CreateCheckoutSessionInput {
  plan: "collector" | "pro";
  userId: string;
  userEmail: string;
}

// ─── Update src/types/billing.types.ts ──────────────────────────────────────
//
// The BillingSubscription type gains platform + provider-neutral fields, and
// the Stripe IDs become nullable (Apple rows have none). Update your existing
// BillingSubscription interface to match this shape.

export interface BillingSubscription {
  id: string;
  userId: string;

  // Stripe IDs are now nullable — only present on platform === 'stripe' rows.
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;

  plan: "starter" | "collector" | "pro";
  status: "trialing" | "active" | "canceled" | "past_due" | "incomplete";

  // NEW: which billing system owns this row.
  platform: "stripe" | "apple" | "google";

  // NEW: RevenueCat app user id (== Supabase user_id) for Apple rows.
  rcAppUserId: string | null;

  // NEW: provider-neutral subscription id (Apple original_transaction_id, etc.)
  // Stripe rows use stripeSubscriptionId; Apple rows use this.
  providerSubscriptionId: string | null;

  trialEndsAt: string | null;
  currentPeriodEnd: string;
  createdAt: string;

  // NEW: set the instant a cancellation is requested (Stripe:
  // cancelSubscription; eventually Apple's RevenueCat CANCELLATION handler),
  // cleared if the cancellation is undone before the period ends. NOT
  // cleared at true expiration — see migrations/2026-08-28_subscriptions_cancel_requested_at.sql.
  // status stays 'active'/'trialing' the whole time this is set; only
  // presence/absence signals cancel intent. Never derive access from this —
  // resolvePlan() keeps using status alone.
  cancelRequestedAt: string | null;
}

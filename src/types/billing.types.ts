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
}

export interface CreateCheckoutSessionInput {
  plan: "collector" | "pro";
  userId: string;
  userEmail: string;
}

export interface BillingSubscription {
  id: string;
  userId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  plan: "collector" | "pro";
  status: "trialing" | "active" | "canceled" | "past_due";
  trialEndsAt: string | null;
  currentPeriodEnd: string;
  createdAt: string;
}

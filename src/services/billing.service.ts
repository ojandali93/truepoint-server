// @ts-nocheck
import Stripe from "stripe";
import { stripe, STRIPE_PRICE_IDS } from "../lib/stripe";
import {
  findSubscriptionByUserId,
  findSubscriptionByStripeId,
  upsertSubscription,
  updateSubscriptionStatus,
  setCancelRequestedAt,
} from "../repositories/billing.repository";
import { BillingSubscription } from "../types/billing.types";

const TRIAL_DAYS = 14;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Stripe moved `current_period_end` from the subscription root to the
 * subscription_item in newer API versions. This helper looks in all the
 * places it might be, returning a safe ISO string or null if none found.
 */
const extractPeriodEnd = (sub: Stripe.Subscription | any): string | null => {
  // Old API: on the subscription root
  if (typeof sub?.current_period_end === "number") {
    return new Date(sub.current_period_end * 1000).toISOString();
  }
  // New API: on the first subscription_item
  const firstItem = sub?.items?.data?.[0];
  if (typeof firstItem?.current_period_end === "number") {
    return new Date(firstItem.current_period_end * 1000).toISOString();
  }
  // Fallback: trial_end or null
  if (typeof sub?.trial_end === "number") {
    return new Date(sub.trial_end * 1000).toISOString();
  }
  return null;
};

/**
 * Derives the cancel_requested_at value to store from Stripe's own
 * subscription fields — Stripe is the source of truth for cancel intent
 * (cancel_at_period_end), not any local flag. Used both right after our own
 * cancel API call and on every customer.subscription.updated webhook, so
 * local state stays correct even if cancellation is requested or undone
 * from Stripe's dashboard/billing portal rather than through this app.
 * `canceled_at` (Stripe's own timestamp for when cancellation was
 * scheduled) is preferred over `new Date()` so the stored time matches
 * Stripe's record exactly; falls back to now() only if Stripe omits it.
 */
const deriveCancelRequestedAt = (sub: Stripe.Subscription): string | null => {
  if (!sub.cancel_at_period_end) return null;
  return sub.canceled_at
    ? new Date(sub.canceled_at * 1000).toISOString()
    : new Date().toISOString();
};

/**
 * Was this subscription trialing (vs. actively paying) at the moment
 * cancellation was requested? Captured here, right where the status is
 * already available, per FEEDBACK_DESIGN.md Phase 3's addition — not
 * reconstructed later from history.
 */
const deriveWasTrial = (sub: Stripe.Subscription): boolean =>
  sub.status === "trialing";

// ─── Checkout Session ─────────────────────────────────────────────────────────

export const createCheckoutSession = async (
  userId: string,
  userEmail: string,
  plan: "collector" | "pro",
): Promise<{ clientSecret: string; sessionId: string }> => {
  if (!STRIPE_PRICE_IDS[plan]) {
    throw {
      status: 400,
      message: `No Stripe price configured for plan: ${plan}`,
    };
  }

  // Reuse existing Stripe customer if they have one
  let customerId: string | undefined;
  const existing = await findSubscriptionByUserId(userId);
  if (existing?.stripeCustomerId) {
    customerId = existing.stripeCustomerId;
  }

  // Create customer if none exists
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: userEmail,
      metadata: { supabase_user_id: userId },
    });
    customerId = customer.id;
  }

  // Create Checkout Session in embedded mode
  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    ui_mode: "embedded_page",
    return_url: `${process.env.FRONTEND_URL}/onboarding?session_id={CHECKOUT_SESSION_ID}&plan=${plan}`,
    line_items: [
      {
        price: STRIPE_PRICE_IDS[plan],
        quantity: 1,
      },
    ],
    subscription_data: {
      trial_period_days: TRIAL_DAYS,
      metadata: {
        supabase_user_id: userId,
        plan,
      },
    },
    metadata: {
      supabase_user_id: userId,
      plan,
    },
  });

  if (!session.client_secret) {
    throw { status: 500, message: "Failed to create checkout session" };
  }

  return {
    clientSecret: session.client_secret,
    sessionId: session.id,
  };
};

// ─── Verify Session After Return ──────────────────────────────────────────────

export const verifyCheckoutSession = async (
  sessionId: string,
  userId: string,
): Promise<BillingSubscription> => {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ["subscription"],
  });

  if (session.metadata?.supabase_user_id !== userId) {
    throw { status: 403, message: "Session does not belong to this user" };
  }

  if (session.status !== "complete") {
    throw { status: 400, message: "Checkout session not complete" };
  }

  const subscription = session.subscription as Stripe.Subscription;
  const plan = (session.metadata?.plan ?? "collector") as "collector" | "pro";

  const trialEnd = subscription.trial_end;
  const periodEndIso = extractPeriodEnd(subscription);

  const saved = await upsertSubscription({
    userId,
    stripeCustomerId: session.customer as string,
    stripeSubscriptionId: subscription.id,
    plan,
    status: subscription.status as BillingSubscription["status"],
    trialEndsAt: trialEnd ? new Date(trialEnd * 1000).toISOString() : null,
    currentPeriodEnd: periodEndIso,
  });

  return saved;
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

export const handleWebhookEvent = async (
  payload: Buffer,
  signature: string,
): Promise<void> => {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch (err: any) {
    await logError({
      source: "handle-webhook-event", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    throw { status: 400, message: "Invalid webhook signature" };
  }

  switch (event.type) {
    case "customer.subscription.trial_will_end": {
      const sub = event.data.object as Stripe.Subscription;
      // TODO: trigger push notification via FCM when Phase 5 is built
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as Stripe.Subscription;
      const periodEndIso = extractPeriodEnd(sub);
      await updateSubscriptionStatus(
        sub.id,
        sub.status as BillingSubscription["status"],
        periodEndIso,
      );
      // Keep cancel intent in sync with Stripe's own cancel_at_period_end on
      // every update — covers cancellation OR reactivation initiated
      // anywhere (this app, Stripe dashboard, a future billing portal), not
      // just the /billing/subscription DELETE path below.
      await setCancelRequestedAt(
        sub.id,
        deriveCancelRequestedAt(sub),
        deriveWasTrial(sub),
      );
      break;
    }

    case "customer.subscription.deleted": {
      // True expiration — the one place status actually becomes 'canceled'.
      // Deliberately does NOT touch cancel_requested_at (left as whatever it
      // already was) — see migrations/2026-08-28_subscriptions_cancel_requested_at.sql
      // for why that's useful signal, not an oversight.
      const sub = event.data.object as Stripe.Subscription;
      const saved = await findSubscriptionByStripeId(sub.id);
      if (saved) {
        await updateSubscriptionStatus(sub.id, "canceled");
      }
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = (invoice as unknown as { subscription: string })
        .subscription;
      if (subId) {
        await updateSubscriptionStatus(subId, "past_due");
      }
      break;
    }

    case "invoice.payment_succeeded": {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = (invoice as unknown as { subscription: string })
        .subscription;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        const periodEndIso = extractPeriodEnd(sub);
        await updateSubscriptionStatus(subId, "active", periodEndIso);
      }
      break;
    }

    default:
      await logError({
        source: "handle-webhook-event", // ← change per controller
        message: `Unhandled webhook event: ${event.type}`,
        error: null,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: {},
      });
  }
};

// ─── Get Subscription ─────────────────────────────────────────────────────────

export const getSubscription = async (
  userId: string,
): Promise<BillingSubscription | null> => {
  return findSubscriptionByUserId(userId);
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export const cancelSubscription = async (userId: string): Promise<void> => {
  const sub = await findSubscriptionByUserId(userId);
  if (!sub) throw { status: 404, message: "No active subscription found" };

  // Cancel at period end — user keeps access until it expires. status is
  // deliberately NOT touched here: resolvePlan() only grants access for
  // status IN ('active','trialing'), so flipping it to 'canceled' the
  // instant this is requested would revoke a still-paying user's plan
  // immediately, contradicting "keeps access until it expires" above. status
  // stays whatever it already was; only cancel_requested_at records intent.
  // The real status transition happens later, unchanged, in
  // handleWebhookEvent's "customer.subscription.deleted" case (true
  // expiration) — see migrations/2026-08-28_subscriptions_cancel_requested_at.sql.
  const updated = await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  await setCancelRequestedAt(
    sub.stripeSubscriptionId,
    deriveCancelRequestedAt(updated),
    deriveWasTrial(updated),
  );
};

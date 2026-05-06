// @ts-nocheck
import Stripe from 'stripe';
import { stripe, STRIPE_PRICE_IDS } from '../lib/stripe';
import {
  findSubscriptionByUserId,
  findSubscriptionByStripeId,
  upsertSubscription,
  updateSubscriptionStatus,
} from '../repositories/billing.repository';
import { updateProfile } from '../repositories/user.repository';
import { BillingSubscription } from '../types/billing.types';

const TRIAL_DAYS = 14;

// ─── Checkout Session ─────────────────────────────────────────────────────────

export const createCheckoutSession = async (
  userId: string,
  userEmail: string,
  plan: 'collector' | 'pro'
): Promise<{ clientSecret: string; sessionId: string }> => {
  if (!STRIPE_PRICE_IDS[plan]) {
    throw { status: 400, message: `No Stripe price configured for plan: ${plan}` };
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
    mode: 'subscription',
    ui_mode: 'embedded',
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
    throw { status: 500, message: 'Failed to create checkout session' };
  }

  return {
    clientSecret: session.client_secret,
    sessionId: session.id,
  };
};

// ─── Verify Session After Return ──────────────────────────────────────────────

export const verifyCheckoutSession = async (
  sessionId: string,
  userId: string
): Promise<BillingSubscription> => {
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['subscription'],
  });

  if (session.metadata?.supabase_user_id !== userId) {
    throw { status: 403, message: 'Session does not belong to this user' };
  }

  if (session.status !== 'complete') {
    throw { status: 400, message: 'Checkout session not complete' };
  }

  const subscription = session.subscription as Stripe.Subscription;
  const plan = (session.metadata?.plan ?? 'collector') as 'collector' | 'pro';

  const trialEnd = subscription.trial_end;
  const periodEnd = (subscription as unknown as { current_period_end: number }).current_period_end;

  const saved = await upsertSubscription({
    userId,
    stripeCustomerId: session.customer as string,
    stripeSubscriptionId: subscription.id,
    plan,
    status: subscription.status as BillingSubscription['status'],
    trialEndsAt: trialEnd ? new Date(trialEnd * 1000).toISOString() : null,
    currentPeriodEnd: new Date(periodEnd * 1000).toISOString(),
  });

  // Upgrade the user's profile to pro member
  await updateProfile(userId, { is_pro_member: true });

  return saved;
};

// ─── Webhook Handler ──────────────────────────────────────────────────────────

export const handleWebhookEvent = async (
  payload: Buffer,
  signature: string
): Promise<void> => {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      payload,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET!
    );
  } catch {
    throw { status: 400, message: 'Invalid webhook signature' };
  }

  switch (event.type) {
    case 'customer.subscription.trial_will_end': {
      const sub = event.data.object as Stripe.Subscription;
      // TODO: trigger push notification via FCM when Phase 5 is built
      console.log('[Billing] Trial ending soon for subscription:', sub.id);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const periodEnd = (sub as unknown as { current_period_end: number }).current_period_end;
      await updateSubscriptionStatus(
        sub.id,
        sub.status as BillingSubscription['status'],
        new Date(periodEnd * 1000).toISOString()
      );
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      const saved = await findSubscriptionByStripeId(sub.id);
      if (saved) {
        await updateSubscriptionStatus(sub.id, 'canceled');
        await updateProfile(saved.userId, { is_pro_member: false });
      }
      break;
    }

    case 'invoice.payment_failed': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = (invoice as unknown as { subscription: string }).subscription;
      if (subId) {
        await updateSubscriptionStatus(subId, 'past_due');
      }
      break;
    }

    case 'invoice.payment_succeeded': {
      const invoice = event.data.object as Stripe.Invoice;
      const subId = (invoice as unknown as { subscription: string }).subscription;
      if (subId) {
        const sub = await stripe.subscriptions.retrieve(subId);
        const periodEnd = (sub as unknown as { current_period_end: number }).current_period_end;
        await updateSubscriptionStatus(
          subId,
          'active',
          new Date(periodEnd * 1000).toISOString()
        );
      }
      break;
    }

    default:
      console.log(`[Billing] Unhandled webhook event: ${event.type}`);
  }
};

// ─── Get Subscription ─────────────────────────────────────────────────────────

export const getSubscription = async (
  userId: string
): Promise<BillingSubscription | null> => {
  return findSubscriptionByUserId(userId);
};

// ─── Cancel Subscription ──────────────────────────────────────────────────────

export const cancelSubscription = async (userId: string): Promise<void> => {
  const sub = await findSubscriptionByUserId(userId);
  if (!sub) throw { status: 404, message: 'No active subscription found' };

  // Cancel at period end — user keeps access until it expires
  await stripe.subscriptions.update(sub.stripeSubscriptionId, {
    cancel_at_period_end: true,
  });

  await updateSubscriptionStatus(sub.stripeSubscriptionId, 'canceled');
};
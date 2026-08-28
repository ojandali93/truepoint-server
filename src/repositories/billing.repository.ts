import { supabaseAdmin } from "../lib/supabase";
import { BillingSubscription } from "../types/billing.types";

// Now includes platform + provider-neutral identifiers.
type SubscriptionRow = {
  id: string;
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  status: string;
  platform: string;
  rc_app_user_id: string | null;
  provider_subscription_id: string | null;
  trial_ends_at: string | null;
  current_period_end: string | null;
  created_at: string;
  cancel_requested_at: string | null;
};

const rowToSubscription = (row: SubscriptionRow): BillingSubscription => ({
  id: row.id,
  userId: row.user_id,
  stripeCustomerId: row.stripe_customer_id,
  stripeSubscriptionId: row.stripe_subscription_id,
  plan: row.plan as BillingSubscription["plan"],
  status: row.status as BillingSubscription["status"],
  platform: row.platform as BillingSubscription["platform"],
  rcAppUserId: row.rc_app_user_id,
  providerSubscriptionId: row.provider_subscription_id,
  trialEndsAt: row.trial_ends_at,
  currentPeriodEnd: row.current_period_end ?? "",
  createdAt: row.created_at,
  cancelRequestedAt: row.cancel_requested_at,
});

// ─── Reads ──────────────────────────────────────────────────────────────────

/**
 * Finds a user's STRIPE subscription specifically. Used by the Stripe billing
 * flow (checkout reuse, cancel). Now platform-scoped because a user may also
 * have an Apple row.
 */
export const findSubscriptionByUserId = async (
  userId: string,
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", "stripe")
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

/**
 * Finds a user's subscription on a specific platform. General-purpose
 * platform-aware lookup (used by the Apple/RevenueCat flow).
 */
export const findSubscriptionByUserIdAndPlatform = async (
  userId: string,
  platform: "stripe" | "apple" | "google",
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .eq("platform", platform)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

/** Returns ALL of a user's subscription rows across platforms. */
export const findAllSubscriptionsByUserId = async (
  userId: string,
): Promise<BillingSubscription[]> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId);
  if (error) throw error;
  return (data ?? []).map((r) => rowToSubscription(r as SubscriptionRow));
};

export const findSubscriptionByStripeId = async (
  stripeSubscriptionId: string,
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

/** Finds an Apple subscription by RevenueCat's original transaction id. */
export const findSubscriptionByProviderId = async (
  providerSubscriptionId: string,
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("provider_subscription_id", providerSubscriptionId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

// ─── Writes ───────────────────────────────────────────────────────────────────

/**
 * Upserts a STRIPE subscription. onConflict is now (user_id, platform) to match
 * the new unique constraint. Always writes platform 'stripe'.
 */
export const upsertSubscription = async (
  payload: Omit<
    BillingSubscription,
    | "id"
    | "createdAt"
    | "platform"
    | "rcAppUserId"
    | "providerSubscriptionId"
    // Repository-controlled, not caller-supplied — always reset to null
    // here (see the cancel_requested_at write below for why).
    | "cancelRequestedAt"
  >,
): Promise<BillingSubscription> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .upsert(
      {
        user_id: payload.userId,
        platform: "stripe",
        stripe_customer_id: payload.stripeCustomerId,
        stripe_subscription_id: payload.stripeSubscriptionId,
        plan: payload.plan,
        status: payload.status,
        trial_ends_at: payload.trialEndsAt,
        current_period_end: payload.currentPeriodEnd,
        // Always reset the whole cancel-intent cluster on upsert: the only
        // caller is verifyCheckoutSession, i.e. a checkout that just
        // completed. A subscription that was just created/reactivated
        // through checkout cannot simultaneously be cancel-pending —
        // without this, ON CONFLICT DO UPDATE only touches the columns
        // listed here, so stale values from a prior subscription on this
        // (user_id, platform) row would survive untouched: cancel_requested_at
        // would wrongly keep showing "canceling" forever, and a stale
        // exit_feedback_prompted_at would silently suppress Flow B2 on the
        // NEXT cancellation too.
        cancel_requested_at: null,
        was_trial_at_cancel: null,
        exit_feedback_prompted_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform" },
    )
    .select()
    .single();
  if (error) throw error;
  return rowToSubscription(data as SubscriptionRow);
};

/**
 * Upserts an APPLE subscription (from the RevenueCat webhook). Keyed on
 * (user_id, platform) so a user's single Apple row is created or updated.
 */
export const upsertAppleSubscription = async (payload: {
  userId: string;
  rcAppUserId: string;
  providerSubscriptionId: string;
  plan: "starter" | "collector" | "pro";
  status: BillingSubscription["status"];
  currentPeriodEnd: string | null;
  trialEndsAt?: string | null;
}): Promise<BillingSubscription> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .upsert(
      {
        user_id: payload.userId,
        platform: "apple",
        rc_app_user_id: payload.rcAppUserId,
        provider_subscription_id: payload.providerSubscriptionId,
        plan: payload.plan,
        status: payload.status,
        trial_ends_at: payload.trialEndsAt ?? null,
        current_period_end: payload.currentPeriodEnd,
        // Same reset-the-whole-cluster reasoning as upsertSubscription
        // above — INITIAL_PURCHASE/RENEWAL/UNCANCELLATION/PRODUCT_CHANGE all
        // route through this function, and any of them can represent "this
        // cancellation is over" (a fresh purchase, a renewal that means the
        // prior cancel never took effect, or an explicit uncancel).
        cancel_requested_at: null,
        was_trial_at_cancel: null,
        exit_feedback_prompted_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id,platform" },
    )
    .select()
    .single();
  if (error) throw error;
  return rowToSubscription(data as SubscriptionRow);
};

/** Updates status by Stripe subscription id (Stripe webhook path). */
export const updateSubscriptionStatus = async (
  stripeSubscriptionId: string,
  status: BillingSubscription["status"],
  currentPeriodEnd?: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status,
      ...(currentPeriodEnd ? { current_period_end: currentPeriodEnd } : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("stripe_subscription_id", stripeSubscriptionId);
  if (error) throw error;
};

/**
 * Records (or clears) cancel intent + Flow B2's staging fields, by whichever
 * id column identifies the platform. Deliberately separate from
 * updateSubscriptionStatus — this never touches `status`, only the
 * cancel-intent marker. See
 * migrations/2026-08-28_subscriptions_cancel_requested_at.sql for why status
 * must stay untouched here (resolvePlan() gates access on status alone), and
 * migrations/2026-08-28_product_feedback.sql for was_trial_at_cancel /
 * exit_feedback_prompted_at.
 *
 * Branches on whether cancel intent is being SET vs CLEARED:
 *   - Clearing (cancelRequestedAt === null, i.e. reactivation/undo from the
 *     Stripe dashboard or a RevenueCat UNCANCELLATION) resets the WHOLE
 *     cancel-intent cluster — was_trial_at_cancel and
 *     exit_feedback_prompted_at both go back to null too, so a future
 *     cancellation asks again from a clean slate.
 *   - Setting (non-null) writes was_trial_at_cancel (safe to re-write
 *     idempotently) but DELIBERATELY leaves exit_feedback_prompted_at
 *     untouched. This function gets called on every
 *     customer.subscription.updated webhook while cancel_at_period_end
 *     stays true, not just once — if it blindly nulled
 *     exit_feedback_prompted_at on every one of those redundant
 *     re-confirmations, it would un-resolve an already answered/dismissed
 *     Flow B2 ask every time Stripe re-sends the same state.
 */
const applyCancelRequestedAt = async (
  column: "stripe_subscription_id" | "provider_subscription_id",
  value: string,
  cancelRequestedAt: string | null,
  wasTrialAtCancel: boolean | null,
): Promise<void> => {
  const updates: Record<string, unknown> = {
    cancel_requested_at: cancelRequestedAt,
    updated_at: new Date().toISOString(),
  };
  if (cancelRequestedAt === null) {
    updates.was_trial_at_cancel = null;
    updates.exit_feedback_prompted_at = null;
  } else {
    updates.was_trial_at_cancel = wasTrialAtCancel;
  }
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update(updates)
    .eq(column, value);
  if (error) throw error;
};

/** STRIPE path — by stripe_subscription_id. */
export const setCancelRequestedAt = (
  stripeSubscriptionId: string,
  cancelRequestedAt: string | null,
  wasTrialAtCancel: boolean | null = null,
): Promise<void> =>
  applyCancelRequestedAt(
    "stripe_subscription_id",
    stripeSubscriptionId,
    cancelRequestedAt,
    wasTrialAtCancel,
  );

/** APPLE path — by provider_subscription_id (RevenueCat's original_transaction_id). */
export const setCancelRequestedAtByProviderId = (
  providerSubscriptionId: string,
  cancelRequestedAt: string | null,
  wasTrialAtCancel: boolean | null = null,
): Promise<void> =>
  applyCancelRequestedAt(
    "provider_subscription_id",
    providerSubscriptionId,
    cancelRequestedAt,
    wasTrialAtCancel,
  );

/** Updates status by provider (Apple) subscription id (RevenueCat path). */
export const updateAppleSubscriptionStatus = async (
  providerSubscriptionId: string,
  status: BillingSubscription["status"],
  currentPeriodEnd?: string | null,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({
      status,
      ...(currentPeriodEnd !== undefined
        ? { current_period_end: currentPeriodEnd }
        : {}),
      updated_at: new Date().toISOString(),
    })
    .eq("provider_subscription_id", providerSubscriptionId);
  if (error) throw error;
};

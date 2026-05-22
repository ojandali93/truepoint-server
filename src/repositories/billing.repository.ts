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
    "id" | "createdAt" | "platform" | "rcAppUserId" | "providerSubscriptionId"
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

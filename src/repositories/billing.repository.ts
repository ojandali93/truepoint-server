import { supabaseAdmin } from "../lib/supabase";
import { BillingSubscription } from "../types/billing.types";

type SubscriptionRow = {
  id: string;
  user_id: string;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  plan: string;
  status: string;
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
  trialEndsAt: row.trial_ends_at,
  currentPeriodEnd: row.current_period_end ?? "",
  createdAt: row.created_at,
});

export const findSubscriptionByUserId = async (
  userId: string,
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

export const findSubscriptionByStripeId = async (
  stripeSubscriptionId: string,
): Promise<BillingSubscription | null> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("*")
    .eq("stripe_subscription_id", stripeSubscriptionId)
    .single();
  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSubscription(data as SubscriptionRow) : null;
};

export const upsertSubscription = async (
  payload: Omit<BillingSubscription, "id" | "createdAt">,
): Promise<BillingSubscription> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .upsert(
      {
        user_id: payload.userId,
        stripe_customer_id: payload.stripeCustomerId,
        stripe_subscription_id: payload.stripeSubscriptionId,
        plan: payload.plan,
        status: payload.status,
        trial_ends_at: payload.trialEndsAt,
        current_period_end: payload.currentPeriodEnd,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .select()
    .single();
  if (error) throw error;
  return rowToSubscription(data as SubscriptionRow);
};

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

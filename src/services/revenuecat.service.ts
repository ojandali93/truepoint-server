// src/services/revenuecat.service.ts
//
// Handles RevenueCat webhook events for Apple (and later Google) subscriptions.
// Mirrors the Stripe webhook pattern: maps provider events to subscription-row
// writes with platform='apple'. The subscriptions table + resolvePlan remain
// the single source of truth — RevenueCat just reliably tells us when to write.
//
// RevenueCat webhook docs: the POST body is { event: {...} }. We authenticate
// it with a shared Authorization header (set in the RevenueCat dashboard).
//
// app_user_id: we configure the RevenueCat SDK on mobile to use the Supabase
// user_id as the RevenueCat app user id, so event.app_user_id IS the user_id.

import {
  upsertAppleSubscription,
  updateAppleSubscriptionStatus,
  findSubscriptionByProviderId,
  setCancelRequestedAtByProviderId,
} from "../repositories/billing.repository";
import { logError } from "../lib/Logger";
import { deactivateGrandfatherCompIfNoRealSubRemains } from "./adminPlatform.service";

// Map store product identifiers → plan tiers.
// These must match the product IDs created in App Store Connect / Google
// Play Console.
//
// Phase 1 gate 6 (UX_OVERHAUL_PLAN.md §7 pricing) — new Pro monthly/yearly
// products added below, legacy collector/pro left in place and NEVER
// removed (§3 decided: "Grandfather the 2 real subscribers on legacy
// products... never delete products" — a legacy subscriber's renewal
// webhook still needs to resolve to a plan).
//
// iOS: event.product_id is the bare ASC product ID (pro_monthly_1499,
// pro_annual_12999) — status "Waiting for Review" as of this writing;
// sandbox purchases resolve correctly today, but these won't be
// purchasable in PRODUCTION until Apple approves them alongside the next
// app binary submission. See paywall.tsx's PRO_PRICING_V2 flag gate —
// this map being ready doesn't mean the paywall should show these yet.
//
// Android: event.product_id for a Play subscription with a base plan is
// "<productId>:<basePlanId>" per RevenueCat's convention. The monthly
// base-plan id is "pro-montly" — that's not a typo introduced here, it's
// AS-CREATED on Google Play Console (missing the 'h'). Copy verbatim.
// Google Play base-plan/product IDs are immutable once created, so
// "fixing" the spelling here would just make this map stop matching the
// real product Play actually sends — the typo is load-bearing now.
const PRODUCT_TO_PLAN: Record<string, "collector" | "pro"> = {
  collector: "collector",
  pro: "pro",
  pro_monthly_1499: "pro",
  pro_annual_12999: "pro",
  "pro_monthly_1499:pro-montly": "pro", // verbatim Play base-plan id — see comment above
  "pro_annual_12999:pro-annual": "pro",
};

// RevenueCat event types we act on.
type RCEventType =
  | "INITIAL_PURCHASE"
  | "RENEWAL"
  | "PRODUCT_CHANGE"
  | "CANCELLATION"
  | "EXPIRATION"
  | "BILLING_ISSUE"
  | "UNCANCELLATION"
  | "SUBSCRIPTION_PAUSED"
  | "TRANSFER";

interface RCEvent {
  type: RCEventType;
  app_user_id: string;
  original_app_user_id?: string;
  product_id?: string;
  // ms since epoch
  expiration_at_ms?: number | null;
  // RevenueCat's stable subscription identifier
  original_transaction_id?: string;
  store?: string; // "APP_STORE" | "PLAY_STORE" | ...
  period_type?: string; // "TRIAL" | "NORMAL" | "INTRO"
}

const planFromProduct = (productId?: string): "collector" | "pro" | null => {
  if (!productId) return null;
  return PRODUCT_TO_PLAN[productId] ?? null;
};

const msToIso = (ms?: number | null): string | null =>
  typeof ms === "number" ? new Date(ms).toISOString() : null;

/**
 * Verify the shared-secret Authorization header RevenueCat sends.
 * Configure this value in the RevenueCat dashboard webhook settings AND set it
 * as REVENUECAT_WEBHOOK_AUTH in your backend env.
 */
export const verifyRevenueCatAuth = (authHeader?: string): boolean => {
  const expected = process.env.REVENUECAT_WEBHOOK_AUTH;
  if (!expected) return false;
  return authHeader === expected;
};

export const handleRevenueCatEvent = async (body: any): Promise<void> => {
  const event: RCEvent | undefined = body?.event;
  if (!event || !event.type) {
    await logError({
      source: "revenuecat-webhook",
      message: "Missing event in RevenueCat payload",
      error: null,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: { body },
    });
    return;
  }

  // We only handle App Store events here. (Play Store later.)
  if (event.store && event.store !== "APP_STORE") {
    return;
  }

  const userId = event.app_user_id;
  const providerId = event.original_transaction_id ?? null;
  const periodEnd = msToIso(event.expiration_at_ms);
  const isTrial = event.period_type === "TRIAL";

  switch (event.type) {
    case "INITIAL_PURCHASE":
    case "RENEWAL":
    case "UNCANCELLATION":
    case "PRODUCT_CHANGE": {
      const plan = planFromProduct(event.product_id);
      if (!plan || !providerId) {
        await logError({
          source: "revenuecat-webhook",
          message: `Could not resolve plan/provider for ${event.type}`,
          error: null,
          userId,
          requestPath: "",
          requestMethod: "",
          metadata: { product_id: event.product_id, providerId },
        });
        return;
      }
      await upsertAppleSubscription({
        userId,
        rcAppUserId: userId,
        providerSubscriptionId: providerId,
        plan,
        status: isTrial ? "trialing" : "active",
        currentPeriodEnd: periodEnd,
        trialEndsAt: isTrial ? periodEnd : null,
      });
      break;
    }

    case "BILLING_ISSUE": {
      if (providerId) {
        await updateAppleSubscriptionStatus(providerId, "past_due", periodEnd);
      }
      break;
    }

    case "CANCELLATION": {
      // Access continues until expiration — status stays active/trialing
      // until it flips on actual EXPIRATION below. NEVER set 'canceled' here;
      // resolvePlan only counts active/trialing, so that would cut access
      // early. This case ONLY records cancel intent for Flow B2 (in-app exit
      // feedback) — a pending-feedback marker, not an access/status/
      // entitlement change. See
      // migrations/2026-08-28_product_feedback.sql and FEEDBACK_DESIGN.md §3.3.
      if (providerId) {
        await setCancelRequestedAtByProviderId(
          providerId,
          msToIso(Date.now()) as string,
          isTrial,
        );
      }
      break;
    }

    case "SUBSCRIPTION_PAUSED": {
      // Google Play-specific (subscription pause) — not wired to the Stripe
      // cancel_at_period_end / Flow B2 marker model; a pause isn't
      // necessarily a cancellation, and Google isn't integrated yet (see
      // upsertAppleSubscription callers above — "Play Store later"). Stays a
      // true no-op: access continues, nothing recorded.
      break;
    }

    case "EXPIRATION": {
      if (providerId) {
        await updateAppleSubscriptionStatus(providerId, "canceled", periodEnd);
        // Phase 1 gate 7: the true terminal event for this real
        // subscription — this is where a grandfathered comp-Pro grant (if
        // any) gets checked and deactivated, per the "tied to the real
        // subscription's lifecycle" ruling. See
        // adminPlatform.service.ts::deactivateGrandfatherCompIfNoRealSubRemains
        // for the full reasoning (won't fire if the user still has another
        // real subscription active elsewhere).
        await deactivateGrandfatherCompIfNoRealSubRemains(userId);
      }
      break;
    }

    case "TRANSFER": {
      // A subscription moved between app_user_ids (e.g. user re-login).
      // Re-point the existing provider row to the new user if needed.
      if (providerId) {
        const existing = await findSubscriptionByProviderId(providerId);
        if (existing && existing.userId !== userId) {
          // Re-create under the new user id (the unique key is user_id+platform).
          // Simplest: upsert under new user, leave old to expire.
          const plan = planFromProduct(event.product_id) ?? existing.plan;
          await upsertAppleSubscription({
            userId,
            rcAppUserId: userId,
            providerSubscriptionId: providerId,
            plan: plan as "collector" | "pro",
            status: existing.status,
            currentPeriodEnd: existing.currentPeriodEnd || null,
          });
        }
      }
      break;
    }

    default: {
      await logError({
        source: "revenuecat-webhook",
        message: `Unhandled RevenueCat event: ${event.type}`,
        error: null,
        userId,
        requestPath: "",
        requestMethod: "",
        metadata: { type: event.type },
      });
    }
  }
};

// src/services/revenuecat.service.ts
//
// Handles RevenueCat webhook events for Apple AND Google subscriptions
// (Android webhook wiring, launch precondition — Google was previously
// dropped entirely, see platformFromStore's header comment below). Mirrors
// the Stripe webhook pattern: maps provider events to subscription-row
// writes, platform derived from the event's own `store` field rather than
// hardcoded. The subscriptions table + resolvePlan remain the single
// source of truth — RevenueCat just reliably tells us when to write.
//
// RevenueCat webhook docs: the POST body is { event: {...} }. We authenticate
// it with a shared Authorization header (set in the RevenueCat dashboard).
//
// app_user_id: we configure the RevenueCat SDK on mobile to use the Supabase
// user_id as the RevenueCat app user id, so event.app_user_id IS the user_id.

import {
  upsertRevenueCatSubscription,
  updateRevenueCatSubscriptionStatus,
  findSubscriptionByProviderId,
  setCancelRequestedAtByProviderId,
} from "../repositories/billing.repository";
import { logError } from "../lib/Logger";
import { deactivateGrandfatherCompIfNoRealSubRemains } from "./adminPlatform.service";
// Phase 1 of AUDITS/affiliate-system-plan.md — additive only, same
// try/catch-isolated pattern as billing.service.ts's Stripe wiring.
import {
  recordRevenueCatEarning,
  recordRevenueCatClawback,
} from "./affiliateCommission.service";

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
  // The webhook event's own unique id — stable across retries per RC's
  // docs (verified live 2026-09-02). Used as commission_ledger's
  // payment_event_id for idempotency; NOT the same as transaction_id,
  // which changes per renewal, or original_transaction_id, which stays
  // fixed for the life of the subscription.
  id: string;
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
  // Phase 1 (affiliate-system-plan.md) commission fields — verified live
  // against RC's current webhook docs 2026-09-02. commission_percentage/
  // tax_percentage are fractions 0–1 (RC's own example: 0.3 = 30%), NOT
  // 0–100. takehome_percentage is deprecated; deliberately not read here.
  price?: number | null; // USD; null/0 for free trials, negative on some refund shapes
  currency?: string | null;
  commission_percentage?: number | null;
  tax_percentage?: number | null;
  // Present on CANCELLATION events. 'CUSTOMER_SUPPORT' = a refund (RC has
  // no dedicated REFUND event type) — see recordRevenueCatClawback.
  cancel_reason?: string | null;
}

const planFromProduct = (productId?: string): "collector" | "pro" | null => {
  if (!productId) return null;
  return PRODUCT_TO_PLAN[productId] ?? null;
};

/**
 * Maps RevenueCat's `event.store` to our platform column. Explicit
 * allowlist, not a blanket pass-through — RevenueCat can also relay
 * STRIPE/PROMOTIONAL/AMAZON/ROKU events, and a RevenueCat-relayed STRIPE
 * event in particular would double-write against this app's OWN direct
 * Stripe webhook if it were accepted here. Only APP_STORE and PLAY_STORE
 * are handled; anything else is logged and skipped (see the caller).
 */
const platformFromStore = (store?: string): "apple" | "google" | null => {
  if (store === "APP_STORE") return "apple";
  if (store === "PLAY_STORE") return "google";
  return null;
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

  // Android webhook wiring (launch precondition): platform is derived from
  // the event's own store, not hardcoded/assumed. A missing or unrecognized
  // store is logged and skipped rather than silently defaulted to Apple —
  // no store, no write. (Previously this dropped every non-APP_STORE event
  // outright, which is the bug this fixes: Play subscriptions were never
  // recorded server-side at all.)
  const platform = platformFromStore(event.store);
  if (!platform) {
    await logError({
      source: "revenuecat-webhook",
      message: `Unrecognized or missing store for RevenueCat event: ${event.store}`,
      error: null,
      userId: event.app_user_id ?? null,
      requestPath: "",
      requestMethod: "",
      metadata: { store: event.store, type: event.type },
    });
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
      await upsertRevenueCatSubscription({
        userId,
        platform,
        rcAppUserId: userId,
        providerSubscriptionId: providerId,
        plan,
        status: isTrial ? "trialing" : "active",
        currentPeriodEnd: periodEnd,
        trialEndsAt: isTrial ? periodEnd : null,
      });

      // Phase 1 (affiliate-system-plan.md) — commission ledger. Only
      // INITIAL_PURCHASE/RENEWAL represent an actual payment; UNCANCELLATION
      // and PRODUCT_CHANGE reach this same block for subscription-status
      // purposes but carry no new revenue to commission.
      if (event.type === "INITIAL_PURCHASE" || event.type === "RENEWAL") {
        try {
          await recordRevenueCatEarning(event, userId, event.type);
        } catch (err: any) {
          await logError({
            source: "affiliate-commission-revenuecat",
            message: err?.message ?? "Failed to record commission earning",
            error: err,
            userId,
            requestPath: "",
            requestMethod: "",
            metadata: { eventId: event.id, type: event.type },
          });
        }
      }
      break;
    }

    case "BILLING_ISSUE": {
      if (providerId) {
        await updateRevenueCatSubscriptionStatus(
          providerId,
          "past_due",
          periodEnd,
        );
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

      // Phase 1 (affiliate-system-plan.md) — RC has no dedicated REFUND
      // event; a refund arrives as CANCELLATION with cancel_reason
      // 'CUSTOMER_SUPPORT' (verified live against RC's current docs
      // 2026-09-02). Every other cancel_reason is normal churn, not a
      // refund — recordRevenueCatClawback re-checks this itself, but gating
      // here too avoids even attempting a DB lookup on the common case.
      if (event.cancel_reason === "CUSTOMER_SUPPORT") {
        try {
          await recordRevenueCatClawback(event, userId);
        } catch (err: any) {
          await logError({
            source: "affiliate-commission-revenuecat",
            message: err?.message ?? "Failed to record commission clawback",
            error: err,
            userId,
            requestPath: "",
            requestMethod: "",
            metadata: { eventId: event.id },
          });
        }
      }
      break;
    }

    case "SUBSCRIPTION_PAUSED": {
      // Google Play-specific (subscription pause) — deliberately still a
      // no-op even now that Google is integrated (Android webhook wiring).
      // Not one of the 4 lifecycle paths this pass wires (initial purchase,
      // renewal, cancellation-marker, expiration): a pause isn't
      // necessarily a cancellation and isn't wired to the Stripe
      // cancel_at_period_end / Flow B2 marker model either. Access
      // continues, nothing recorded — flagged as a real gap, not fixed
      // here; revisit if Play pause behavior needs its own status.
      break;
    }

    case "EXPIRATION": {
      if (providerId) {
        await updateRevenueCatSubscriptionStatus(
          providerId,
          "canceled",
          periodEnd,
        );
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
          await upsertRevenueCatSubscription({
            userId,
            platform,
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

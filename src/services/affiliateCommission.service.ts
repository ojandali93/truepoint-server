// affiliateCommission.service.ts
//
// Phase 1 of AUDITS/affiliate-system-plan.md — turns a payment/refund event
// into a commission_ledger row. Split into two layers on purpose:
//
//   1. recordEarning / recordClawback — pure ledger-writing logic, given
//      already-resolved gross/fees/net figures. No Stripe/RevenueCat SDK
//      calls, no network access. This is the part with real business-logic
//      risk (rate application, the first-payment window anchor, self-
//      referral blocking, append-only clawback linkage, idempotency) and
//      the part scripts/validateAffiliateCommissionLedger.ts exercises
//      directly with representative inputs.
//
//   2. recordStripeEarningFromInvoice / recordStripeClawbackFromCharge /
//      recordRevenueCatEarning / recordRevenueCatClawback — platform-
//      specific glue that resolves the real gross/fees/net from Stripe's
//      balance transactions or RevenueCat's webhook fields, then calls
//      layer 1. This is the part that depends on live API shape and can't
//      be fully exercised without a real Stripe/RevenueCat test-mode
//      webhook — see this file's own comments at each network call for
//      what's defensive-but-unverified vs. confirmed against current docs.
//
// billing.service.ts and revenuecat.service.ts call layer 2 from their
// existing webhook switches; neither webhook handler's existing subscription-
// status logic is touched — commission recording is strictly additive, and
// every call site wraps it in try/catch + logError so a commission bug can
// never break a real subscription-status update.

import { stripe } from "../lib/stripe";
import { logError } from "../lib/Logger";
import * as commissionRepo from "../repositories/affiliateCommission.repository";

// ─── Repository seam ────────────────────────────────────────────────────────
//
// recordEarning/recordClawback take their repository as a parameter,
// defaulting to the real one (commissionRepo below). Every real call site
// (billing.service.ts, revenuecat.service.ts) just omits the second
// argument and gets the real DB. scripts/validateAffiliateCommissionLedger.ts
// passes an in-memory fake instead — the ledger math (rate application, the
// first-payment window anchor, self-referral blocking, append-only
// clawback linkage, idempotency) is real business logic worth testing
// directly, without needing a real auth user + profiles row + affiliate
// row created and torn down in the live DB just to exercise it.

export type AffiliateCommissionRepo = {
  findAttributionByUserId: typeof commissionRepo.findAttributionByUserId;
  setAttributionWindowIfUnset: typeof commissionRepo.setAttributionWindowIfUnset;
  getAffiliateRateInfo: typeof commissionRepo.getAffiliateRateInfo;
  insertLedgerRowIdempotent: typeof commissionRepo.insertLedgerRowIdempotent;
  findLedgerRowByEvent: typeof commissionRepo.findLedgerRowByEvent;
  findMostRecentEarningRowForUser: typeof commissionRepo.findMostRecentEarningRowForUser;
};

const defaultRepo: AffiliateCommissionRepo = commissionRepo;

// ─── Shared helpers ─────────────────────────────────────────────────────────

const round2 = (n: number): number => Math.round(n * 100) / 100;

const addMonthsIso = (iso: string, months: number): string => {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
};

const payoutPeriodOf = (earnedAtIso: string): string => earnedAtIso.slice(0, 7); // 'YYYY-MM'

// ─── Layer 1: pure ledger logic ────────────────────────────────────────────

export interface PaymentEventInput {
  userId: string;
  sourcePlatform: "stripe" | "revenuecat";
  paymentEventId: string;
  paymentEventType: string;
  gross: number;
  fees: number;
  net: number;
  currency: string;
  earnedAt: string; // ISO
}

export type RecordEarningResult =
  | { outcome: "recorded"; ledgerRowId: string }
  | { outcome: "duplicate_skipped" }
  | { outcome: "no_attribution" }
  | { outcome: "unresolved_attribution" }
  | { outcome: "self_referral_blocked" }
  | { outcome: "affiliate_inactive" }
  | { outcome: "window_expired" }
  | { outcome: "no_revenue" };

/**
 * Records one earning row for a payment event, or explains why it didn't.
 * Every branch is a real, expected outcome in steady state (an un-referred
 * user, an expired window) — only the caller decides which outcomes are
 * worth logging.
 */
export async function recordEarning(
  input: PaymentEventInput,
  repo: AffiliateCommissionRepo = defaultRepo,
): Promise<RecordEarningResult> {
  if (input.gross <= 0) return { outcome: "no_revenue" };

  const attribution = await repo.findAttributionByUserId(input.userId);
  if (!attribution) return { outcome: "no_attribution" };
  if (!attribution.resolved || !attribution.affiliate_id) {
    return { outcome: "unresolved_attribution" };
  }

  const affiliate = await repo.getAffiliateRateInfo(attribution.affiliate_id);
  if (!affiliate) return { outcome: "unresolved_attribution" };

  // Fraud §4 — self-referral hard block. Defense-in-depth: Phase 3's
  // attribution resolution is supposed to reject this at signup time, but
  // this table has no way to guarantee every future write path remembers
  // to check, so the ledger itself refuses to pay an affiliate on their own
  // account regardless of how the attribution row came to exist.
  if (affiliate.user_id && affiliate.user_id === input.userId) {
    return { outcome: "self_referral_blocked" };
  }

  if (!affiliate.active) return { outcome: "affiliate_inactive" };

  // First-payment window anchor — ruled 2026-09-02: 12 months (or the
  // affiliate's custom commission_window_months) from the referred user's
  // FIRST PAYMENT, never from signup. set-once via the repository's
  // `.is("window_start", null)` filter.
  let windowEnd = attribution.window_end;
  if (!attribution.window_start) {
    windowEnd = addMonthsIso(input.earnedAt, affiliate.commission_window_months);
    await repo.setAttributionWindowIfUnset(attribution.id, input.earnedAt, windowEnd);
  }

  if (windowEnd && new Date(input.earnedAt) > new Date(windowEnd)) {
    return { outcome: "window_expired" };
  }

  const rateApplied = affiliate.commission_rate;
  const commissionAmount = round2(input.net * rateApplied);

  const inserted = await repo.insertLedgerRowIdempotent({
    affiliate_id: affiliate.id,
    referred_user_id: input.userId,
    attribution_id: attribution.id,
    source_platform: input.sourcePlatform,
    payment_event_id: input.paymentEventId,
    payment_event_type: input.paymentEventType,
    gross: round2(input.gross),
    fees: round2(input.fees),
    net: round2(input.net),
    currency: input.currency,
    rate_applied: rateApplied,
    commission_amount: commissionAmount,
    is_clawback: false,
    clawback_of: null,
    earned_at: input.earnedAt,
    payout_period: payoutPeriodOf(input.earnedAt),
    status: "eligible",
  });

  if (!inserted) return { outcome: "duplicate_skipped" };
  return { outcome: "recorded", ledgerRowId: inserted.id };
}

export interface ClawbackEventInput {
  userId: string;
  sourcePlatform: "stripe" | "revenuecat";
  paymentEventId: string; // the refund/chargeback event's OWN id — never reused from the original earning row
  paymentEventType: string;
  refundGross: number; // positive magnitude
  refundFees: number; // positive magnitude
  refundNet: number; // positive magnitude
  currency: string;
  earnedAt: string;
  // Exact link for Stripe (the invoice id the refunded charge belongs to —
  // doc §3.2). Omit for RevenueCat, whose refund event carries no reliable
  // per-transaction back-reference — see findMostRecentEarningRowForUser's
  // header comment for why "most recent" is the documented-correct fallback
  // there, not a guess.
  originalPaymentEventId?: string | null;
}

export type RecordClawbackResult =
  | { outcome: "recorded"; ledgerRowId: string }
  | { outcome: "duplicate_skipped" }
  | { outcome: "no_original_row_found" }
  | { outcome: "no_attribution" };

/**
 * Clawbacks are append-only (doc §2, restated by you 2026-09-02): this
 * function only ever INSERTS a new negative row referencing the original
 * via clawback_of. It never updates or deletes the original earning row —
 * the ledger has to stay readable line by line six months out, and that
 * only holds if history is never rewritten.
 */
export async function recordClawback(
  input: ClawbackEventInput,
  repo: AffiliateCommissionRepo = defaultRepo,
): Promise<RecordClawbackResult> {
  const attribution = await repo.findAttributionByUserId(input.userId);
  if (!attribution || !attribution.affiliate_id) {
    return { outcome: "no_attribution" };
  }

  const original = input.originalPaymentEventId
    ? await repo.findLedgerRowByEvent(input.sourcePlatform, input.originalPaymentEventId)
    : await repo.findMostRecentEarningRowForUser(input.userId, input.sourcePlatform);

  if (!original) return { outcome: "no_original_row_found" };

  // rate_applied mirrors the ORIGINAL row's stored rate, never a fresh
  // lookup of the affiliate's current rate (doc §3.1) — a rate change
  // between the earning and the refund must not distort what's being
  // reversed.
  const commissionAmount = -Math.abs(round2(input.refundNet * original.rate_applied));

  const inserted = await repo.insertLedgerRowIdempotent({
    affiliate_id: original.affiliate_id,
    referred_user_id: input.userId,
    attribution_id: attribution.id,
    source_platform: input.sourcePlatform,
    payment_event_id: input.paymentEventId,
    payment_event_type: input.paymentEventType,
    gross: -Math.abs(round2(input.refundGross)),
    fees: -Math.abs(round2(input.refundFees)),
    net: -Math.abs(round2(input.refundNet)),
    currency: input.currency,
    rate_applied: original.rate_applied,
    commission_amount: commissionAmount,
    is_clawback: true,
    clawback_of: original.id,
    earned_at: input.earnedAt,
    payout_period: payoutPeriodOf(input.earnedAt),
    status: "eligible",
  });

  if (!inserted) return { outcome: "duplicate_skipped" };
  return { outcome: "recorded", ledgerRowId: inserted.id };
}

// ─── Layer 2: Stripe glue ───────────────────────────────────────────────────
//
// Type note: this stripe-node version (22.1.0, per package.json) does not
// expose Stripe.Invoice/Charge/Refund/BalanceTransaction as dotted members
// off the default import the way older versions did — StripeConstructor's
// own namespace only re-exports the `Stripe` class type itself (confirmed
// via node_modules/stripe/cjs/stripe.cjs.node.d.ts; `Stripe.Invoice` etc.
// fails to compile with "Namespace 'StripeConstructor' has no exported
// member"). Deriving types from the live `stripe` client's own method
// signatures sidesteps that entirely and stays accurate to whatever this
// pinned SDK actually returns, instead of fighting its type re-export chain.

type StripeInvoice = Awaited<ReturnType<typeof stripe.invoices.retrieve>>;
type StripeCharge = Awaited<ReturnType<typeof stripe.charges.retrieve>>;
type StripeRefund = Awaited<ReturnType<typeof stripe.refunds.retrieve>>;

// Structural, not the SDK's own BalanceTransaction type: a directly-
// retrieved balance transaction and one reached via an expanded nested
// field (charge.balance_transaction) are different nominal types in this
// SDK version (the former carries a `lastResponse` wrapper, the latter
// doesn't) even though both carry the same amount/fee/net/currency fields
// this function actually needs — the narrower structural type accepts both.
type BalanceTransactionLike = {
  amount: number;
  fee: number;
  net: number;
  currency: string;
};

type ResolvedAmounts = { gross: number; fees: number; net: number; currency: string };

const btToAmounts = (bt: BalanceTransactionLike): ResolvedAmounts => ({
  gross: bt.amount / 100,
  fees: bt.fee / 100,
  net: bt.net / 100,
  currency: bt.currency,
});

/**
 * Resolves the real net Stripe paid out for an invoice, from the charge's
 * BALANCE TRANSACTION — never the invoice's own gross total (your
 * instruction, 2026-09-02). Multi-path and defensive on purpose, same
 * pattern as billing.service.ts's existing extractPeriodEnd: this repo's
 * Stripe API version (2026-04-22.dahlia, per src/lib/stripe.ts) has already
 * moved current_period_end between shapes once, and Stripe's invoice→charge
 * linkage has evolved across API versions industry-wide (top-level `charge`
 * deprecated in favor of a `payments` collection in some versions) — so
 * this tries every path a live webhook could plausibly present rather than
 * assuming one.
 *
 * The estimate fallback at the bottom is NOT expected to fire in normal
 * operation — if it does, that's a real gap in this resolution logic worth
 * knowing about, which is why it's logError'd rather than silently used.
 */
export async function resolveStripeInvoiceNet(
  invoice: StripeInvoice,
): Promise<ResolvedAmounts> {
  // PRIMARY path, empirically verified 2026-09-02 against a real Stripe
  // TEST-mode payment on this exact pinned API version (stripe-node 22.1.0,
  // "2026-04-22.dahlia" — see src/lib/stripe.ts) via
  // scripts/smokeTestStripeCommissionLedger.ts: this API version's Invoice
  // object has NO top-level `charge` or `payment_intent` field at all (both
  // guessed at defensively before this was run against a real payment, and
  // both were wrong — the smoke test's first real run silently fell through
  // to the estimate below on a live, fully-paid invoice, which is exactly
  // the failure mode running this once for real exists to catch). The real
  // link is invoice.payments.data[].payment, a polymorphic object with
  // `type: "charge" | "payment_intent"` and the id on the matching field —
  // confirmed live shape: `{ payment_intent: "pi_...", type: "payment_intent" }`.
  try {
    const payment = (
      invoice as unknown as {
        payments?: {
          data?: Array<{ payment?: { type?: string; charge?: string; payment_intent?: string } }>;
        };
      }
    ).payments?.data?.[0]?.payment;

    if (payment?.type === "charge" && payment.charge) {
      const charge = await stripe.charges.retrieve(payment.charge, {
        expand: ["balance_transaction"],
      });
      const bt = charge.balance_transaction;
      if (bt && typeof bt !== "string") return btToAmounts(bt);
    } else if (payment?.type === "payment_intent" && payment.payment_intent) {
      const pi = await stripe.paymentIntents.retrieve(payment.payment_intent, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = pi.latest_charge;
      const bt = charge && typeof charge !== "string" ? charge.balance_transaction : null;
      if (bt && typeof bt !== "string") return btToAmounts(bt);
    }
  } catch {
    // fall through to the legacy paths below
  }

  // Legacy/defensive fallbacks — the shapes older Stripe API versions (and
  // this file's original, pre-verification guesses) used. Harmless to keep:
  // cheap to try, and a real safety net if a future API version reintroduces
  // a top-level field. Neither matched on this pinned version's real
  // response (confirmed by the smoke test), which is why the block above,
  // not these, is now PRIMARY.
  try {
    const chargeId =
      typeof (invoice as unknown as { charge?: string | StripeCharge }).charge === "string"
        ? ((invoice as unknown as { charge: string }).charge)
        : null;
    if (chargeId) {
      const charge = await stripe.charges.retrieve(chargeId, {
        expand: ["balance_transaction"],
      });
      const bt = charge.balance_transaction;
      if (bt && typeof bt !== "string") return btToAmounts(bt);
    }
  } catch {
    // fall through
  }

  try {
    const piId = (invoice as unknown as { payment_intent?: string }).payment_intent;
    if (piId) {
      const pi = await stripe.paymentIntents.retrieve(piId, {
        expand: ["latest_charge.balance_transaction"],
      });
      const charge = pi.latest_charge;
      const bt =
        charge && typeof charge !== "string" ? charge.balance_transaction : null;
      if (bt && typeof bt !== "string") return btToAmounts(bt);
    }
  } catch {
    // fall through to the estimate
  }

  await logError({
    source: "affiliate-commission-stripe",
    message:
      "Falling back to estimated fee — no balance transaction resolved for invoice (see resolveStripeInvoiceNet)",
    error: null,
    userId: null,
    requestPath: "",
    requestMethod: "",
    metadata: { invoiceId: invoice.id },
  });
  const gross = (invoice.amount_paid ?? 0) / 100;
  const fees = round2(gross * 0.029 + 0.3); // doc §3.2's stated estimate formula
  return { gross, fees, net: round2(gross - fees), currency: invoice.currency ?? "usd" };
}

/** Same balance-transaction resolution, for a refund. */
export async function resolveStripeRefundNet(
  refund: StripeRefund,
): Promise<ResolvedAmounts> {
  try {
    const btId = refund.balance_transaction;
    if (btId) {
      const bt =
        typeof btId === "string"
          ? await stripe.balanceTransactions.retrieve(btId)
          : btId;
      return btToAmounts(bt);
    }
  } catch {
    // fall through to the estimate
  }

  await logError({
    source: "affiliate-commission-stripe",
    message:
      "Falling back to estimated fee — no balance transaction resolved for refund (see resolveStripeRefundNet)",
    error: null,
    userId: null,
    requestPath: "",
    requestMethod: "",
    metadata: { refundId: refund.id },
  });
  const gross = (refund.amount ?? 0) / 100;
  const fees = round2(gross * 0.029 + 0.3);
  return { gross, fees, net: round2(gross - fees), currency: refund.currency ?? "usd" };
}

export async function recordStripeEarningFromInvoice(
  invoice: StripeInvoice,
  userId: string,
): Promise<RecordEarningResult> {
  const amounts = await resolveStripeInvoiceNet(invoice);
  return recordEarning({
    userId,
    sourcePlatform: "stripe",
    paymentEventId: invoice.id,
    paymentEventType: "invoice.payment_succeeded",
    gross: amounts.gross,
    fees: amounts.fees,
    net: amounts.net,
    currency: amounts.currency,
    earnedAt: new Date().toISOString(), // webhook delivery time — Stripe invoices don't carry a separate "paid at" beyond status_transitions, which isn't reliably present on every API version
  });
}

export async function recordStripeClawbackFromRefund(
  refund: StripeRefund,
  userId: string,
  originalInvoiceId: string | null,
): Promise<RecordClawbackResult> {
  const amounts = await resolveStripeRefundNet(refund);
  return recordClawback({
    userId,
    sourcePlatform: "stripe",
    paymentEventId: refund.id,
    paymentEventType: "charge.refunded",
    refundGross: amounts.gross,
    refundFees: amounts.fees,
    refundNet: amounts.net,
    currency: amounts.currency,
    earnedAt: new Date().toISOString(),
    originalPaymentEventId: originalInvoiceId,
  });
}

// ─── Layer 2: RevenueCat glue ───────────────────────────────────────────────

/**
 * RevenueCat webhook fields, verified live against RC's current webhook
 * docs 2026-09-02 (not assumed from training data — takehome_percentage is
 * explicitly deprecated there in favor of these two, both expressed as
 * fractions 0–1, confirmed from RC's own documented example
 * ("commission_percentage": 0.3 meaning 30%) — NOT 0–100).
 */
export interface RCCommissionFields {
  id: string; // the webhook event's own id — stable across retries per RC's docs, used as payment_event_id
  price?: number | null; // USD; null/0 for free trials, negative for refunds
  currency?: string | null;
  commission_percentage?: number | null; // fraction 0–1
  tax_percentage?: number | null; // fraction 0–1
  cancel_reason?: string | null; // 'CUSTOMER_SUPPORT' = refund; see recordRevenueCatClawback
}

export async function recordRevenueCatEarning(
  event: RCCommissionFields,
  userId: string,
  eventType: "INITIAL_PURCHASE" | "RENEWAL",
  repo: AffiliateCommissionRepo = defaultRepo,
  earnedAt: string = new Date().toISOString(),
): Promise<RecordEarningResult | { outcome: "no_price" }> {
  const gross = event.price ?? 0;
  if (gross <= 0) return { outcome: "no_price" };

  const commissionPct = event.commission_percentage ?? 0;
  const taxPct = event.tax_percentage ?? 0;
  const fees = round2(gross * (commissionPct + taxPct));
  const net = round2(gross - fees);

  return recordEarning(
    {
      userId,
      sourcePlatform: "revenuecat",
      paymentEventId: event.id,
      paymentEventType: eventType,
      gross,
      fees,
      net,
      currency: (event.currency ?? "USD").toLowerCase(),
      earnedAt,
    },
    repo,
  );
}

/**
 * A refund on RevenueCat's side arrives as a CANCELLATION event with
 * cancel_reason 'CUSTOMER_SUPPORT' — RC has no dedicated REFUND event type
 * (verified live against current docs 2026-09-02; REFUND_REVERSED exists
 * for the opposite case only). Every other cancel_reason (UNSUBSCRIBE,
 * BILLING_ERROR, DEVELOPER_INITIATED, PRICE_INCREASE, UNKNOWN) is normal
 * churn, not a refund, and must NOT write a clawback row — callers gate on
 * cancel_reason before calling this, but this function re-checks so a
 * future call site can't accidentally clawback a plain unsubscribe.
 */
export async function recordRevenueCatClawback(
  event: RCCommissionFields,
  userId: string,
  repo: AffiliateCommissionRepo = defaultRepo,
  earnedAt: string = new Date().toISOString(),
): Promise<RecordClawbackResult | { outcome: "not_a_refund" }> {
  if (event.cancel_reason !== "CUSTOMER_SUPPORT") {
    return { outcome: "not_a_refund" };
  }

  const refundGross = Math.abs(event.price ?? 0);
  const commissionPct = event.commission_percentage ?? 0;
  const taxPct = event.tax_percentage ?? 0;
  const refundFees = round2(refundGross * (commissionPct + taxPct));
  const refundNet = round2(refundGross - refundFees);

  return recordClawback(
    {
      userId,
      sourcePlatform: "revenuecat",
      paymentEventId: event.id,
      paymentEventType: "CANCELLATION:CUSTOMER_SUPPORT",
      refundGross,
      refundFees,
      refundNet,
      currency: (event.currency ?? "USD").toLowerCase(),
      earnedAt,
      // No originalPaymentEventId — RC's refund event has no confirmed exact
      // transaction back-reference. findMostRecentEarningRowForUser is the
      // documented-correct link here, not a guess: RC's own docs state this
      // event "fires only when the LATEST subscription period is refunded."
    },
    repo,
  );
}

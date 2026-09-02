// validateAffiliateCommissionLedger.ts
//
// Phase 1 gate (AUDITS/affiliate-system-plan.md, per your 2026-09-02
// instruction): "a validation script replaying representative payment +
// refund events (Stripe and RevenueCat, including a duplicate delivery)
// asserting correct ledger rows."
//
// SCOPE, stated plainly: this exercises Layer 1 of
// src/services/affiliateCommission.service.ts — recordEarning/
// recordClawback, and (since they make no network calls) the RevenueCat
// glue functions recordRevenueCatEarning/recordRevenueCatClawback end to
// end. It runs entirely offline against an in-memory fake repository
// (AffiliateCommissionRepo) instead of the live DB — no real auth user,
// profiles row, or affiliate row is created or torn down, and no Stripe/
// RevenueCat network calls are made.
//
// This is deliberate, not a shortcut: the business logic actually at risk
// of a real bug — rate application, the first-payment window anchor,
// self-referral blocking, append-only clawback linkage, idempotency on
// (source_platform, payment_event_id) — lives entirely in that layer and
// is fully exercised here, repeatably, without touching production data.
//
// NOT covered here, flagged rather than silently claimed: the Stripe-side
// balance-transaction resolution (resolveStripeInvoiceNet/
// resolveStripeRefundNet in affiliateCommission.service.ts) depends on
// live Stripe API response shape and can only be verified against a real
// Stripe test-mode webhook — do that before this goes further than an
// internal/allowlist audience. The Postgres-level idempotency constraint
// itself (the actual unique index from migrations/
// 2026-09-02_affiliate_commission_system.sql) is exercised by the fake
// repo's equivalent in-memory check, not by hitting the live index — see
// the header comment on FakeRepo.insertLedgerRowIdempotent below for why
// that's a faithful stand-in, not a weaker one.
//
// Run: npx ts-node scripts/validateAffiliateCommissionLedger.ts

import {
  recordEarning,
  recordClawback,
  recordRevenueCatEarning,
  recordRevenueCatClawback,
  type AffiliateCommissionRepo,
  type PaymentEventInput,
} from "../src/services/affiliateCommission.service";
import type {
  ReferralAttributionRow,
  AffiliateRateInfo,
  CommissionLedgerInsert,
  CommissionLedgerRow,
} from "../src/repositories/affiliateCommission.repository";

// ─── Tiny assertion helpers (no test framework dependency, matches this
// repo's existing scripts/ convention of plain ts-node scripts) ───────────

let pass = 0;
let fail = 0;

function assertEqual<T>(label: string, actual: T, expected: T) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

function assertTrue(label: string, condition: boolean) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label} — condition was false`);
  }
}

// ─── In-memory fake repository ─────────────────────────────────────────────

class FakeRepo implements AffiliateCommissionRepo {
  attributions = new Map<string, ReferralAttributionRow>();
  affiliates = new Map<string, AffiliateRateInfo>();
  ledger: CommissionLedgerRow[] = [];
  private ledgerIdSeq = 1;

  findAttributionByUserId: AffiliateCommissionRepo["findAttributionByUserId"] =
    async (userId) => this.attributions.get(userId) ?? null;

  setAttributionWindowIfUnset: AffiliateCommissionRepo["setAttributionWindowIfUnset"] =
    async (attributionId, windowStart, windowEnd) => {
      // Mirrors the real repository's `.is("window_start", null)` filter —
      // set-once, silently no-ops if already set (never overwrites).
      for (const attribution of this.attributions.values()) {
        if (attribution.id === attributionId && attribution.window_start === null) {
          attribution.window_start = windowStart;
          attribution.window_end = windowEnd;
        }
      }
    };

  getAffiliateRateInfo: AffiliateCommissionRepo["getAffiliateRateInfo"] = async (
    affiliateId,
  ) => this.affiliates.get(affiliateId) ?? null;

  // Mirrors the real repository's 23505-unique-violation-returns-null
  // contract (migrations/2026-09-02_affiliate_commission_system.sql's
  // `commission_ledger_source_event_unique` index) — same observable
  // behavior (insert-or-null-on-collision), just enforced with a Map
  // lookup instead of a Postgres constraint. What's being tested here is
  // the SERVICE layer's response to that contract (does a duplicate
  // delivery correctly produce zero new rows?), not the constraint's own
  // enforcement, which is Postgres's job and isn't re-tested here.
  insertLedgerRowIdempotent: AffiliateCommissionRepo["insertLedgerRowIdempotent"] =
    async (row: CommissionLedgerInsert) => {
      const collision = this.ledger.find(
        (r) =>
          r.source_platform === row.source_platform &&
          r.payment_event_id === row.payment_event_id,
      );
      if (collision) return null;
      const inserted: CommissionLedgerRow = {
        ...row,
        id: `ledger-${this.ledgerIdSeq++}`,
        created_at: new Date().toISOString(),
      };
      this.ledger.push(inserted);
      return inserted;
    };

  findLedgerRowByEvent: AffiliateCommissionRepo["findLedgerRowByEvent"] = async (
    sourcePlatform,
    paymentEventId,
  ) =>
    this.ledger.find(
      (r) => r.source_platform === sourcePlatform && r.payment_event_id === paymentEventId,
    ) ?? null;

  findMostRecentEarningRowForUser: AffiliateCommissionRepo["findMostRecentEarningRowForUser"] =
    async (referredUserId, sourcePlatform) => {
      const rows = this.ledger
        .filter(
          (r) =>
            r.referred_user_id === referredUserId &&
            r.source_platform === sourcePlatform &&
            !r.is_clawback,
        )
        .sort((a, b) => (a.earned_at < b.earned_at ? 1 : -1));
      return rows[0] ?? null;
    };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const repo = new FakeRepo();

// Standard-rate affiliate: default 20% / 12 months.
repo.affiliates.set("aff-standard", {
  id: "aff-standard",
  user_id: "user-affiliate-standard",
  active: true,
  commission_rate: 0.2,
  commission_window_months: 12,
});

// Negotiated creator deal: custom 30% / 6 months (doc §1 — "schema must
// support per-affiliate custom rates and windows, NOT a hardcoded
// 20%/12mo").
repo.affiliates.set("aff-custom", {
  id: "aff-custom",
  user_id: "user-affiliate-custom",
  active: true,
  commission_rate: 0.3,
  commission_window_months: 6,
});

repo.affiliates.set("aff-inactive", {
  id: "aff-inactive",
  user_id: "user-affiliate-inactive",
  active: false,
  commission_rate: 0.2,
  commission_window_months: 12,
});

repo.attributions.set("user-referred-standard", {
  id: "attr-1",
  user_id: "user-referred-standard",
  affiliate_id: "aff-standard",
  raw_code_entered: "joes-cards",
  resolved: true,
  source: "web_cookie",
  window_start: null,
  window_end: null,
  attributed_at: "2026-01-01T00:00:00.000Z",
});

repo.attributions.set("user-referred-custom", {
  id: "attr-2",
  user_id: "user-referred-custom",
  affiliate_id: "aff-custom",
  raw_code_entered: "creator-deal",
  resolved: true,
  source: "mobile_manual",
  window_start: null,
  window_end: null,
  attributed_at: "2026-01-01T00:00:00.000Z",
});

repo.attributions.set("user-self-referral", {
  id: "attr-3",
  user_id: "user-self-referral",
  affiliate_id: "aff-standard", // aff-standard's user_id is a DIFFERENT user — this row simulates someone else's attribution for the self-referral scenario below with aff-standard's own account instead
  resolved: true,
  raw_code_entered: "joes-cards",
  source: "web_cookie",
  window_start: null,
  window_end: null,
  attributed_at: "2026-01-01T00:00:00.000Z",
});

repo.attributions.set("user-referred-inactive-aff", {
  id: "attr-4",
  user_id: "user-referred-inactive-aff",
  affiliate_id: "aff-inactive",
  resolved: true,
  raw_code_entered: "inactive-code",
  source: "web_cookie",
  window_start: null,
  window_end: null,
  attributed_at: "2026-01-01T00:00:00.000Z",
});

const stripeEarningBase: PaymentEventInput = {
  userId: "user-referred-standard",
  sourcePlatform: "stripe",
  paymentEventId: "in_test_month1",
  paymentEventType: "invoice.payment_succeeded",
  gross: 14.99,
  fees: 0.73, // ~2.9% + $0.30, representative of a real Stripe balance transaction fee
  net: 14.26,
  currency: "usd",
  earnedAt: "2026-01-15T12:00:00.000Z",
};

// ─── Test runner ────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Stripe earning: first payment sets the window ===");
  const r1 = await recordEarning(stripeEarningBase, repo);
  assertEqual("first payment recorded", r1, { outcome: "recorded", ledgerRowId: "ledger-1" });
  const attr1 = repo.attributions.get("user-referred-standard")!;
  assertEqual("window_start anchored to first payment", attr1.window_start, "2026-01-15T12:00:00.000Z");
  assertEqual("window_end = window_start + 12 months (aff-standard)", attr1.window_end, "2027-01-15T12:00:00.000Z");
  const row1 = repo.ledger[0];
  assertEqual("rate_applied = affiliate's rate at write time", row1.rate_applied, 0.2);
  assertEqual("commission_amount = net * rate", row1.commission_amount, round2(14.26 * 0.2));
  assertEqual("gross/fees/net stored exactly as given (Stripe balance-transaction figures)", [row1.gross, row1.fees, row1.net], [14.99, 0.73, 14.26]);
  assertEqual("status starts eligible", row1.status, "eligible");

  console.log("\n=== Idempotency: duplicate delivery of the SAME Stripe invoice.payment_succeeded ===");
  const r1dup = await recordEarning(stripeEarningBase, repo);
  assertEqual("duplicate delivery is a no-op, not a second row", r1dup, { outcome: "duplicate_skipped" });
  assertEqual("ledger still has exactly 1 row for this event", repo.ledger.filter((r) => r.payment_event_id === "in_test_month1").length, 1);

  console.log("\n=== Second month's renewal: window NOT re-anchored ===");
  const month2 = { ...stripeEarningBase, paymentEventId: "in_test_month2", earnedAt: "2026-02-15T12:00:00.000Z" };
  const r2 = await recordEarning(month2, repo);
  assertTrue("month 2 recorded", r2.outcome === "recorded");
  assertEqual("window_start unchanged by the second payment", repo.attributions.get("user-referred-standard")!.window_start, "2026-01-15T12:00:00.000Z");

  console.log("\n=== Window expiry: a payment 13 months after first payment earns nothing ===");
  const monthAfterWindow = { ...stripeEarningBase, paymentEventId: "in_test_month13", earnedAt: "2027-02-15T12:00:00.000Z" };
  const r13 = await recordEarning(monthAfterWindow, repo);
  assertEqual("payment past window_end is not commissioned", r13, { outcome: "window_expired" });
  assertTrue("no row written for the expired-window payment", !repo.ledger.some((r) => r.payment_event_id === "in_test_month13"));

  console.log("\n=== Custom per-affiliate rate/window (negotiated creator deal: 30% / 6mo) ===");
  const customEarning: PaymentEventInput = {
    userId: "user-referred-custom",
    sourcePlatform: "stripe",
    paymentEventId: "in_test_custom_1",
    paymentEventType: "invoice.payment_succeeded",
    gross: 129.99,
    fees: 4.07,
    net: 125.92,
    currency: "usd",
    earnedAt: "2026-03-01T00:00:00.000Z",
  };
  const rCustom = await recordEarning(customEarning, repo);
  assertTrue("custom-rate affiliate's payment recorded", rCustom.outcome === "recorded");
  const customRow = repo.ledger.find((r) => r.payment_event_id === "in_test_custom_1")!;
  assertEqual("custom 30% rate applied, not the 20% default", customRow.rate_applied, 0.3);
  assertEqual("commission computed off the custom rate", customRow.commission_amount, round2(125.92 * 0.3));
  assertEqual("custom 6-month window, not the 12-month default", repo.attributions.get("user-referred-custom")!.window_end, "2026-09-01T00:00:00.000Z");

  console.log("\n=== Self-referral is blocked ===");
  const selfReferral: PaymentEventInput = {
    userId: "user-affiliate-standard", // the affiliate's OWN account — matches aff-standard.user_id
    sourcePlatform: "stripe",
    paymentEventId: "in_test_self",
    paymentEventType: "invoice.payment_succeeded",
    gross: 14.99,
    fees: 0.73,
    net: 14.26,
    currency: "usd",
    earnedAt: "2026-01-20T00:00:00.000Z",
  };
  // Attach an attribution row for the affiliate's own account, pointing at
  // their own affiliate id — exactly the fraud scenario doc §4 describes.
  repo.attributions.set("user-affiliate-standard", {
    id: "attr-self",
    user_id: "user-affiliate-standard",
    affiliate_id: "aff-standard",
    resolved: true,
    raw_code_entered: "joes-cards",
    source: "web_cookie",
    window_start: null,
    window_end: null,
    attributed_at: "2026-01-01T00:00:00.000Z",
  });
  const rSelf = await recordEarning(selfReferral, repo);
  assertEqual("self-referral blocked, no commission paid", rSelf, { outcome: "self_referral_blocked" });
  assertTrue("no row written for the self-referral", !repo.ledger.some((r) => r.payment_event_id === "in_test_self"));

  console.log("\n=== Inactive affiliate earns nothing ===");
  const inactiveEarning: PaymentEventInput = {
    userId: "user-referred-inactive-aff",
    sourcePlatform: "stripe",
    paymentEventId: "in_test_inactive",
    paymentEventType: "invoice.payment_succeeded",
    gross: 14.99,
    fees: 0.73,
    net: 14.26,
    currency: "usd",
    earnedAt: "2026-01-20T00:00:00.000Z",
  };
  const rInactive = await recordEarning(inactiveEarning, repo);
  assertEqual("inactive affiliate does not earn", rInactive, { outcome: "affiliate_inactive" });

  console.log("\n=== Un-referred user: no attribution row at all ===");
  const organic: PaymentEventInput = {
    userId: "user-organic-no-referral",
    sourcePlatform: "stripe",
    paymentEventId: "in_test_organic",
    paymentEventType: "invoice.payment_succeeded",
    gross: 14.99,
    fees: 0.73,
    net: 14.26,
    currency: "usd",
    earnedAt: "2026-01-20T00:00:00.000Z",
  };
  const rOrganic = await recordEarning(organic, repo);
  assertEqual("no attribution -> no commission, the ~100% steady-state case", rOrganic, { outcome: "no_attribution" });

  console.log("\n=== Stripe clawback: append-only, exact link via original invoice id ===");
  const rowsBeforeClawback = repo.ledger.length;
  const clawback1 = await recordClawback(
    {
      userId: "user-referred-standard",
      sourcePlatform: "stripe",
      paymentEventId: "re_test_refund_month1",
      paymentEventType: "charge.refunded",
      refundGross: 14.99,
      refundFees: 0.73,
      refundNet: 14.26,
      currency: "usd",
      earnedAt: "2026-01-20T00:00:00.000Z",
      originalPaymentEventId: "in_test_month1",
    },
    repo,
  );
  assertTrue("clawback recorded", clawback1.outcome === "recorded");
  assertEqual("clawback is a NEW row, original row count unchanged", repo.ledger.length, rowsBeforeClawback + 1);
  const clawbackRow = repo.ledger.find((r) => r.payment_event_id === "re_test_refund_month1")!;
  assertTrue("clawback row is_clawback = true", clawbackRow.is_clawback === true);
  assertEqual("clawback links to the exact original row via clawback_of", clawbackRow.clawback_of, row1.id);
  assertEqual("clawback commission is negative, mirroring the original's rate", clawbackRow.commission_amount, -round2(14.26 * 0.2));
  assertEqual("clawback gross/fees/net are negative magnitudes", [clawbackRow.gross, clawbackRow.fees, clawbackRow.net], [-14.99, -0.73, -14.26]);
  assertTrue("ORIGINAL row is untouched — true append-only", row1.commission_amount === round2(14.26 * 0.2) && row1.is_clawback === false);

  console.log("\n=== Idempotency: duplicate delivery of the SAME Stripe refund ===");
  const clawback1dup = await recordClawback(
    {
      userId: "user-referred-standard",
      sourcePlatform: "stripe",
      paymentEventId: "re_test_refund_month1",
      paymentEventType: "charge.refunded",
      refundGross: 14.99,
      refundFees: 0.73,
      refundNet: 14.26,
      currency: "usd",
      earnedAt: "2026-01-20T00:00:00.000Z",
      originalPaymentEventId: "in_test_month1",
    },
    repo,
  );
  assertEqual("duplicate refund delivery is a no-op", clawback1dup, { outcome: "duplicate_skipped" });

  console.log("\n=== RevenueCat earning: fraction-based commission_percentage/tax_percentage math ===");
  repo.attributions.set("user-rc-referred", {
    id: "attr-rc-1",
    user_id: "user-rc-referred",
    affiliate_id: "aff-standard",
    resolved: true,
    raw_code_entered: "joes-cards",
    source: "mobile_manual",
    window_start: null,
    window_end: null,
    attributed_at: "2026-01-01T00:00:00.000Z",
  });
  const rcEarning1 = await recordRevenueCatEarning(
    {
      id: "evt_rc_initial_1",
      price: 14.99,
      currency: "USD",
      commission_percentage: 0.3, // Apple's standard 30% store commission, as a FRACTION per RC's confirmed docs
      tax_percentage: 0.0,
    },
    "user-rc-referred",
    "INITIAL_PURCHASE",
    repo,
    "2026-01-10T00:00:00.000Z",
  );
  assertTrue("RC initial purchase recorded", "outcome" in rcEarning1 && rcEarning1.outcome === "recorded");
  const rcRow1 = repo.ledger.find((r) => r.payment_event_id === "evt_rc_initial_1")!;
  assertEqual("RC fees = gross * (commission_percentage + tax_percentage), fraction not percent", rcRow1.fees, round2(14.99 * 0.3));
  assertEqual("RC net = gross - fees", rcRow1.net, round2(14.99 - round2(14.99 * 0.3)));

  console.log("\n=== Idempotency: duplicate delivery of the SAME RevenueCat event (webhook retry) ===");
  const rcEarning1dup = await recordRevenueCatEarning(
    {
      id: "evt_rc_initial_1", // same event.id — RC's docs confirm this is stable across retries
      price: 14.99,
      currency: "USD",
      commission_percentage: 0.3,
      tax_percentage: 0.0,
    },
    "user-rc-referred",
    "INITIAL_PURCHASE",
    repo,
    "2026-01-10T00:00:00.000Z",
  );
  assertEqual("RC webhook retry is a no-op, not a second row", rcEarning1dup, { outcome: "duplicate_skipped" });

  console.log("\n=== RevenueCat clawback: 'most recent earning row' linkage (no exact transaction_id available) ===");
  const rcClawback1 = await recordRevenueCatClawback(
    {
      id: "evt_rc_cancellation_refund_1",
      price: -14.99,
      currency: "USD",
      commission_percentage: 0.3,
      tax_percentage: 0.0,
      cancel_reason: "CUSTOMER_SUPPORT",
    },
    "user-rc-referred",
    repo,
    "2026-01-25T00:00:00.000Z",
  );
  assertTrue("RC refund-cancellation recorded as a clawback", "outcome" in rcClawback1 && rcClawback1.outcome === "recorded");
  const rcClawbackRow = repo.ledger.find((r) => r.payment_event_id === "evt_rc_cancellation_refund_1")!;
  assertEqual("RC clawback links to the most recent (only) RC earning row for this user", rcClawbackRow.clawback_of, rcRow1.id);
  assertTrue("RC clawback is negative", rcClawbackRow.commission_amount < 0);

  console.log("\n=== A plain unsubscribe (not a refund) must NOT clawback anything ===");
  const rcNonRefundCancel = await recordRevenueCatClawback(
    {
      id: "evt_rc_cancellation_voluntary",
      price: 0,
      currency: "USD",
      cancel_reason: "UNSUBSCRIBE",
    },
    "user-rc-referred",
    repo,
  );
  assertEqual("UNSUBSCRIBE is not treated as a refund", rcNonRefundCancel, { outcome: "not_a_refund" });
  assertTrue("no clawback row written for a plain unsubscribe", !repo.ledger.some((r) => r.payment_event_id === "evt_rc_cancellation_voluntary"));

  console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

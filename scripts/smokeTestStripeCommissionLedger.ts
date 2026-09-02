// smokeTestStripeCommissionLedger.ts
//
// Phase 2 follow-up you asked for directly: "resolveStripeInvoiceNet/
// resolveStripeRefundNet touching the real API once is the difference
// between defensive code and verified code." This drives a REAL Stripe
// TEST-mode payment and a real refund, then calls the actual functions the
// webhook path uses (affiliateCommission.service.ts's
// resolveStripeInvoiceNet/resolveStripeRefundNet — exported for this
// script) and asserts the gross/fees/net they return are sane.
//
// SCOPE: this verifies the Stripe API-shape resolution ONLY — it does NOT
// write to commission_ledger or touch Supabase at all (no real
// referral_attributions/affiliate row is needed; the FK constraints those
// tables carry to a real profiles row would otherwise force creating a
// throwaway real user account just to run a smoke test, which this
// deliberately avoids). scripts/validateAffiliateCommissionLedger.ts
// already covers the ledger-writing logic itself, offline. Together the
// two scripts cover the two things Phase 1 flagged as separately unverified.
//
// SAFETY: refuses to run against anything but a TEST-mode secret key
// (sk_test_...). It creates a real (test-mode, fake-money) customer,
// invoice, payment, and refund, then deletes the test customer.
//
// A SEPARATE VARIABLE, on purpose: reads STRIPE_TEST_SECRET_KEY, NOT
// STRIPE_SECRET_KEY — the latter is the real client's key (src/lib/stripe.ts,
// production/live), and this script must never depend on swapping it back
// and forth by hand. Nothing else in this codebase reads
// STRIPE_TEST_SECRET_KEY (grepped 2026-09-02) — it exists only for this
// script. src/lib/stripe.ts itself is untouched and still reads only
// STRIPE_SECRET_KEY.
//
// WHAT TO SET, since this key isn't wired anywhere else:
//   1. Stripe Dashboard → Developers → API keys → toggle "Test mode" (top
//      right) → reveal/copy the Secret key (starts with sk_test_).
//      Do NOT use the Render-configured key for this app — that's the LIVE
//      key, and this script must never run against it.
//   2. In truepoint-server/.env (gitignored — safe), add:
//        STRIPE_TEST_SECRET_KEY=sk_test_...
//      Leave STRIPE_SECRET_KEY exactly as it already is (or unset) — this
//      script never reads it.
//   3. No Supabase env vars are required to run this script (unlike
//      validateAffiliateCommissionLedger.ts's dummy-var workaround, this
//      script never imports the repository layer).
//
// Run: npx ts-node scripts/smokeTestStripeCommissionLedger.ts

import "dotenv/config";

let pass = 0;
let fail = 0;

function assertTrue(label: string, condition: boolean, detail?: unknown) {
  if (condition) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
  }
}

async function main() {
  const testKey = process.env.STRIPE_TEST_SECRET_KEY ?? "";
  if (!testKey.startsWith("sk_test_")) {
    console.error(
      "Refusing to run: STRIPE_TEST_SECRET_KEY is not set to a TEST-mode key (must start with sk_test_).\n" +
        "This script creates and refunds a real charge — see this file's header comment for exactly what to set.",
    );
    process.exit(1);
  }

  // Redirect the SHARED client's key before src/lib/stripe.ts is loaded —
  // that module constructs its Stripe client eagerly, at import time, from
  // process.env.STRIPE_SECRET_KEY. Reassigning it here, in this script's
  // own process only (never touching the .env file, never visible to any
  // other process, and never reached if the guard above already exited),
  // makes the shared client — and therefore resolveStripeInvoiceNet/
  // resolveStripeRefundNet, which call it internally — authenticate with
  // the verified TEST-mode key instead of whatever STRIPE_SECRET_KEY
  // happens to hold (production/live, or nothing).
  //
  // Deliberately `require()`, not a static `import`, for both modules
  // below: a static import of src/lib/stripe (or anything importing it
  // transitively) is not guaranteed to evaluate strictly after this
  // reassignment in every module system, and getting that ordering wrong
  // here means silently authenticating against the wrong key. A require()
  // call runs exactly at this line, every time — no ambiguity.
  process.env.STRIPE_SECRET_KEY = testKey;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { stripe } = require("../src/lib/stripe") as typeof import("../src/lib/stripe");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const {
    resolveStripeInvoiceNet,
    resolveStripeRefundNet,
  } = require("../src/services/affiliateCommission.service") as typeof import("../src/services/affiliateCommission.service");

  console.log("=== Creating a throwaway Stripe TEST-mode customer ===");
  const customer = await stripe.customers.create({
    email: "phase2-smoketest@reverseholo.io",
    description: "affiliateCommission Phase 2 smoke test — safe to delete, TEST mode only",
  });
  console.log(`  customer: ${customer.id}`);

  try {
    console.log("\n=== Attaching a test payment method (tok_visa) ===");
    const pm = await stripe.paymentMethods.create({
      type: "card",
      card: { token: "tok_visa" },
    });
    await stripe.paymentMethods.attach(pm.id, { customer: customer.id });
    await stripe.customers.update(customer.id, {
      invoice_settings: { default_payment_method: pm.id },
    });

    console.log("\n=== Creating + paying a real $14.99 test invoice ===");
    await stripe.invoiceItems.create({
      customer: customer.id,
      amount: 1499,
      currency: "usd",
      description: "affiliateCommission Phase 2 smoke test line item",
    });
    // pending_invoice_items_behavior: "include" is required explicitly on
    // this pinned API version — found live, running this against a real
    // test-mode key: without it, invoices.create() does NOT pull in the
    // pending item above (lines.data stays empty, total stays 0), and the
    // invoice finalizes as a trivially-already-"paid" $0 invoice instead of
    // a real charge. That's exactly what silently produced the first failed
    // run of this script — resolveStripeInvoiceNet correctly fell through
    // to its estimate fallback on a genuinely-empty invoice, which looked
    // like a resolution bug but was actually this.
    const draft = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "charge_automatically",
      pending_invoice_items_behavior: "include",
    });
    // finalizeInvoice triggers Stripe's own automatic collection attempt
    // synchronously when the customer already has a default payment method
    // (set above) — found live, running this against a real test-mode key:
    // the invoice frequently comes back already `paid` from finalization
    // itself, and a subsequent explicit .pay() call 400s with "Invoice is
    // already paid" rather than being a harmless no-op. Check status first.
    const finalized = await stripe.invoices.finalizeInvoice(draft.id!);
    const paid =
      finalized.status === "paid" ? finalized : await stripe.invoices.pay(finalized.id!);
    console.log(`  invoice: ${paid.id}, status: ${paid.status}, amount_paid: ${paid.amount_paid}`);

    console.log("\n=== resolveStripeInvoiceNet (the exact function billing.service.ts calls) ===");
    const earning = await resolveStripeInvoiceNet(paid);
    console.log(`  ${JSON.stringify(earning)}`);
    assertTrue("gross matches the $14.99 invoice", earning.gross === 14.99, earning);
    assertTrue("fees are positive and less than gross (a real Stripe processing fee)", earning.fees > 0 && earning.fees < earning.gross, earning);
    assertTrue("net = gross - fees, to the cent", Math.round((earning.gross - earning.fees) * 100) / 100 === earning.net, earning);
    assertTrue("currency is usd", earning.currency === "usd", earning);
    // Sanity band on Stripe's real ~2.9% + $0.30 card fee — catches a
    // resolution path silently landing on the wrong object (e.g. reading
    // some other charge's balance transaction) without hardcoding an exact
    // cent figure that could legitimately drift with Stripe's own rates.
    assertTrue("fee is in a plausible ~2.9%+$0.30 card-fee band ($0.30–$1.20)", earning.fees >= 0.3 && earning.fees <= 1.2, earning);

    console.log("\n=== Finding the real charge to refund ===");
    const charges = await stripe.charges.list({ customer: customer.id, limit: 1 });
    const charge = charges.data[0];
    if (!charge) throw new Error("No charge found for the test customer — payment did not go through");
    console.log(`  charge: ${charge.id}`);

    console.log("\n=== Issuing a real test-mode refund ===");
    const refund = await stripe.refunds.create({ charge: charge.id });
    console.log(`  refund: ${refund.id}, status: ${refund.status}, amount: ${refund.amount}`);

    console.log("\n=== resolveStripeRefundNet (the exact function billing.service.ts's charge.refunded case calls) ===");
    const clawback = await resolveStripeRefundNet(refund);
    console.log(`  ${JSON.stringify(clawback)}`);
    // A refund's own balance transaction is naturally NEGATIVE (money
    // leaving the platform) — confirmed live: {gross: -14.99, fees: 0, net:
    // -14.99}. recordClawback (Layer 1) takes Math.abs() of these before
    // applying its own sign convention, so this negative sign is correct
    // input, not a bug — assert on magnitude, matching what the real
    // ledger-writing code actually depends on.
    assertTrue("refund magnitude matches the $14.99 refund", Math.abs(clawback.gross) === 14.99, clawback);
    assertTrue("refund fee is 0 — Stripe does not return its processing fee on a standard refund", clawback.fees === 0, clawback);
    assertTrue("refund net = gross - fees, to the cent", Math.round((clawback.gross - clawback.fees) * 100) / 100 === clawback.net, clawback);
    assertTrue("refund currency is usd", clawback.currency === "usd", clawback);

    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  } finally {
    console.log("\n=== Cleanup: deleting the test customer ===");
    try {
      await stripe.customers.del(customer.id);
      console.log("  deleted.");
    } catch (e) {
      console.error("  cleanup failed — delete manually in the Stripe test dashboard:", customer.id, e);
    }
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

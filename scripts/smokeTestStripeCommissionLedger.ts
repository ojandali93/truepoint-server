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
// WHAT TO SET, since this key isn't in your local .env:
//   1. Stripe Dashboard → Developers → API keys → toggle "Test mode" (top
//      right) → reveal/copy the Secret key (starts with sk_test_).
//      Do NOT use the Render-configured key for this app — that's the LIVE
//      key, and this script must never run against it.
//   2. Create truepoint-server/.env (gitignored — safe) if you don't have
//      one, and add:
//        STRIPE_SECRET_KEY=sk_test_...
//   3. This script also loads ../src/lib/stripe.ts, which is the only
//      module it touches — no Supabase env vars are required to run it
//      (unlike validateAffiliateCommissionLedger.ts's dummy-var workaround,
//      this script never imports the repository layer).
//
// Run: npx ts-node scripts/smokeTestStripeCommissionLedger.ts

import "dotenv/config";
import { stripe } from "../src/lib/stripe";
import {
  resolveStripeInvoiceNet,
  resolveStripeRefundNet,
} from "../src/services/affiliateCommission.service";

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
  const key = process.env.STRIPE_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_")) {
    console.error(
      "Refusing to run: STRIPE_SECRET_KEY is not a TEST-mode key (must start with sk_test_).\n" +
        "This script creates and refunds a real charge — see this file's header comment for exactly what to set.",
    );
    process.exit(1);
  }

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
    const draft = await stripe.invoices.create({
      customer: customer.id,
      collection_method: "charge_automatically",
    });
    const finalized = await stripe.invoices.finalizeInvoice(draft.id!);
    const paid = await stripe.invoices.pay(finalized.id!);
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
    assertTrue("refund gross matches the $14.99 refund", clawback.gross === 14.99, clawback);
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

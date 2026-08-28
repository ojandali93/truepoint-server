// scripts/validateCancelLifecycle.ts
//
// Gate for the cancel-status fix in billing.service.ts::cancelSubscription
// (see migrations/2026-08-28_subscriptions_cancel_requested_at.sql for the
// bug this fixes: a Stripe cancel used to flip status='canceled' the
// instant it was requested, which resolvePlan() reads as "no access" —
// revoking a still-paying user's plan immediately instead of at period end).
//
// Runs the REAL code paths — billing.service.ts::cancelSubscription (hits
// Stripe, test mode), plan.service.ts::resolvePlan, and
// renewalReminder.service.ts::getRenewalReminderCandidates (the extracted
// query, not the full sweep — this deliberately never calls
// sendRenewalReminders() itself, since that sends real emails as a side
// effect; a repeatable gate script shouldn't email anyone on every run) —
// against one fully synthetic, disposable Stripe test subscription + Supabase
// auth user created and torn down within this run. Nothing here touches any
// real account.
//
// Asserts the full lifecycle in order:
//   1. active, no cancel requested  -> has access, IS a renewal-reminder
//      candidate
//   2. cancel requested (real cancelSubscription() call) -> access UNCHANGED,
//      status still active/trialing, cancel_requested_at now set, NO LONGER
//      a renewal-reminder candidate
//   3. true expiration (what customer.subscription.deleted's handler does)
//      -> access revoked, cancel_requested_at left AS-IS (not cleared — see
//      the migration file for why that's intentional)
//   4. reactivation (upsertSubscription, i.e. what a fresh completed
//      checkout does) -> cancel_requested_at reset to null
//
// REQUIRES: migrations/2026-08-28_subscriptions_cancel_requested_at.sql
// applied first (Supabase SQL editor — not applied automatically). This
// script fails loudly, not silently, if the column doesn't exist yet.
//
// Usage: npx ts-node scripts/validateCancelLifecycle.ts

import "dotenv/config";
import { stripe, STRIPE_PRICE_IDS } from "../src/lib/stripe";
import { supabaseAdmin } from "../src/lib/supabase";
import {
  findSubscriptionByUserId,
  updateSubscriptionStatus,
  upsertSubscription,
} from "../src/repositories/billing.repository";
import { cancelSubscription } from "../src/services/billing.service";
import { resolvePlan } from "../src/services/plan.service";
import { getRenewalReminderCandidates } from "../src/services/renewalReminder.service";

const TAG = `qa-cancel-lifecycle-${Date.now()}`;
const TEST_EMAIL = `${TAG}@example.com`;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const line = `  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`;
  console.log(line);
  if (!ok) failures++;
}

async function main() {
  console.log(`\n=== Cancel-status lifecycle validation (${TAG}) ===\n`);

  // ─── Setup: fully synthetic, disposable Stripe test sub + Supabase user ──
  const customer = await stripe.customers.create({
    email: TEST_EMAIL,
    payment_method: "pm_card_visa",
    invoice_settings: { default_payment_method: "pm_card_visa" },
    metadata: { qa_disposable: "true", tag: TAG },
  });

  const stripeSub = await stripe.subscriptions.create({
    customer: customer.id,
    items: [{ price: STRIPE_PRICE_IDS.collector }],
    trial_period_days: 3, // inside the renewal-reminder 3-day window on purpose
    metadata: { qa_disposable: "true", tag: TAG },
  });

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: `Test-${Math.random().toString(36).slice(2)}Aa1!`,
    email_confirm: true,
    user_metadata: { qa_disposable: true, tag: TAG },
  });
  if (userErr || !userData?.user) throw userErr ?? new Error("createUser returned no user");
  const userId = userData.user.id;

  const periodEndIso = new Date(
    (stripeSub.trial_end ?? Math.floor(Date.now() / 1000) + 3 * 86400) * 1000,
  ).toISOString();

  const { error: subErr } = await supabaseAdmin.from("subscriptions").insert({
    user_id: userId,
    platform: "stripe",
    plan: "collector",
    // 'active', not the Stripe-side 'trialing' this synthetic sub actually
    // has (trial_period_days below is a fixture trick to get a real Stripe
    // subscription with current_period_end inside the 3-day renewal window
    // without waiting a month — it doesn't reflect this test's intended
    // state). renewalReminder.service.ts's query filters status='active'
    // only (trials don't "renew" — separate, pre-existing, out-of-scope
    // behavior); resolvePlan() and cancelSubscription() don't care what
    // this local value is either way, so this is a safe, deliberate
    // decoupling from Stripe's own status for this one field.
    status: "active",
    stripe_customer_id: customer.id,
    stripe_subscription_id: stripeSub.id,
    current_period_end: periodEndIso,
  });
  if (subErr) throw subErr;

  try {
    // ─── State 1: active, no cancel requested ───────────────────────────────
    console.log("State 1 — active, no cancel requested:");
    const plan1 = await resolvePlan(userId);
    check("has paid plan access", plan1.plan === "collector", `plan=${plan1.plan}`);

    const cands1 = await getRenewalReminderCandidates();
    const inCands1 = cands1.candidates.some((c) => c.user_id === userId);
    check("IS a renewal-reminder candidate", inCands1);

    // ─── State 2: cancel requested — the real cancelSubscription() call ────
    console.log("\nState 2 — cancel requested (real cancelSubscription()):");
    await cancelSubscription(userId);

    const row2 = await findSubscriptionByUserId(userId);
    check("access intact: status still active/trialing", !!row2 && ["active", "trialing"].includes(row2.status), `status=${row2?.status}`);

    const plan2 = await resolvePlan(userId);
    check("access intact: resolvePlan unchanged", plan2.plan === "collector", `plan=${plan2.plan}`);

    check("cancel_requested_at now set (canceling/pending-end readable)", !!row2?.cancelRequestedAt, `cancelRequestedAt=${row2?.cancelRequestedAt}`);

    const cands2 = await getRenewalReminderCandidates();
    const inCands2 = cands2.candidates.some((c) => c.user_id === userId);
    check("NO LONGER a renewal-reminder candidate", !inCands2);

    // Stripe side, sanity: confirm cancel_at_period_end actually took.
    const stripeSubAfterCancel = await stripe.subscriptions.retrieve(stripeSub.id);
    check("Stripe: cancel_at_period_end true", stripeSubAfterCancel.cancel_at_period_end === true);
    check("Stripe: subscription NOT immediately canceled", stripeSubAfterCancel.status !== "canceled", `status=${stripeSubAfterCancel.status}`);

    // ─── State 3: true expiration — what customer.subscription.deleted does ─
    console.log("\nState 3 — true expiration:");
    await updateSubscriptionStatus(stripeSub.id, "canceled");

    const plan3 = await resolvePlan(userId);
    check("access revoked", plan3.plan === "starter", `plan=${plan3.plan}`);

    const row3 = await findSubscriptionByUserId(userId);
    check("cancel_requested_at left AS-IS, not cleared", !!row3?.cancelRequestedAt);

    const cands3 = await getRenewalReminderCandidates();
    check("still not a renewal-reminder candidate", !cands3.candidates.some((c) => c.user_id === userId));

    // ─── State 4: reactivation — what a fresh completed checkout does ──────
    console.log("\nState 4 — reactivation (upsertSubscription, as verifyCheckoutSession does):");
    await upsertSubscription({
      userId,
      stripeCustomerId: customer.id,
      stripeSubscriptionId: stripeSub.id,
      plan: "collector",
      status: "active" as const,
      trialEndsAt: null,
      currentPeriodEnd: periodEndIso,
    });
    const row4 = await findSubscriptionByUserId(userId);
    check("cancel_requested_at reset to null on fresh upsert", row4?.cancelRequestedAt === null, `cancelRequestedAt=${row4?.cancelRequestedAt}`);
  } finally {
    // ─── Cleanup — always, regardless of pass/fail ──────────────────────────
    console.log("\nCleaning up disposable test resources…");
    try { await stripe.subscriptions.cancel(stripeSub.id); } catch (e: any) { console.log("  stripe sub cancel:", e.message); }
    try { await stripe.customers.del(customer.id); } catch (e: any) { console.log("  stripe customer del:", e.message); }
    await supabaseAdmin.from("subscriptions").delete().eq("user_id", userId);
    await supabaseAdmin.auth.admin.deleteUser(userId);
    console.log("  done.");
  }

  console.log(
    failures === 0
      ? "\n✅ PASS — full cancel lifecycle behaves as designed\n"
      : `\n❌ FAIL — ${failures} assertion(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

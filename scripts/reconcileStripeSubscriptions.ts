// scripts/reconcileStripeSubscriptions.ts
//
// EMERGENCY FIX 2026-08-30, step 4 (BACKLOG.md "Stripe webhook signature
// verification broken since 2026-06-29"): every Stripe webhook has failed
// signature verification since 2026-06-29, so every `subscriptions` row with
// platform='stripe' has been frozen at whatever verifyCheckoutSession set at
// initial checkout for up to two months — renewals, cancellations, and
// trial->paid conversions never applied. This script is the read-only audit
// step: pull every platform='stripe' row and diff it against Stripe's own
// live API state for that subscription. It makes NO writes anywhere —
// reports divergences only. Per the ruling on this branch: fix rows only
// after a human has seen this list, not automatically.
//
// Compares three things per row, each capable of drifting independently
// during the outage:
//   - status            (Stripe's subscription.status, mapped to our enum)
//   - current_period_end (via the same multi-fallback extraction
//                          billing.service.ts's extractPeriodEnd uses —
//                          duplicated here, not imported, since that helper
//                          isn't exported; keep both in sync if either changes)
//   - cancel intent      (Stripe's cancel_at_period_end boolean vs whether
//                          our cancel_requested_at is set at all — a
//                          presence/absence check, not a value diff, since
//                          the two sides don't share a type)
//
// IMPORTANT — test mode vs live mode: Stripe test-mode and live-mode objects
// are entirely separate spaces; a test key gets "No such subscription" for
// every real (live-mode) row, not a meaningful "diverged" result. This
// script reads STRIPE_SECRET_KEY from the environment as-is (same as the
// rest of the app) and prints which mode it detected before doing any work,
// specifically because the only sk_test_ key available in local .env as of
// this writing could NOT see the one real (live-mode) row in this table —
// confirmed with a direct stripe.subscriptions.retrieve() lookup that 404'd.
// Render's live-mode key is required for a real run (see CLAUDE.md's
// env-var-source-of-truth rule: Render is the source of truth, local .env is
// a dev copy that drifts).
//
// ALSO NOTE (found running the Stripe CLI gate for this same branch,
// 2026-08-30): subscriptions.exit_feedback_prompted_at / was_trial_at_cancel
// don't exist in the live DB yet (migrations/2026-08-28_product_feedback.sql
// was apparently never run) — see BACKLOG.md. That blocks the WRITE paths
// (webhook handler, verifyCheckoutSession) but not this script, which only
// selects the pre-existing columns below and never touches those two.
//
// Usage: npx ts-node scripts/reconcileStripeSubscriptions.ts

import "dotenv/config";
import { stripe } from "../src/lib/stripe";
import { supabaseAdmin } from "../src/lib/supabase";
// Deliberately not importing the `Stripe` namespace for typing here — this
// file lives under scripts/, outside tsconfig.json's `include` (src/**/*
// only), and ts-node's standalone compile of files outside that graph fails
// to resolve Stripe.Subscription/.Event/.Invoice as real members of the
// StripeConstructor namespace (same symptom as the 16 pre-existing errors
// found removing billing.service.ts's @ts-nocheck). `tsc --noEmit` alone
// doesn't catch this either, since it never type-checks anything outside
// `include` — confirmed by running it and seeing no error here, then
// discovering scripts/ isn't compiled at all. Every other script in this
// directory avoids typed Stripe references for the same reason; matching
// that convention with plain `any` rather than fighting the resolution.

// Mirrors billing.service.ts's non-exported extractPeriodEnd exactly.
const extractPeriodEnd = (sub: any): string | null => {
  if (typeof sub?.current_period_end === "number") {
    return new Date(sub.current_period_end * 1000).toISOString();
  }
  const firstItem = sub?.items?.data?.[0];
  if (typeof firstItem?.current_period_end === "number") {
    return new Date(firstItem.current_period_end * 1000).toISOString();
  }
  if (typeof sub?.trial_end === "number") {
    return new Date(sub.trial_end * 1000).toISOString();
  }
  return null;
};

// Our BillingSubscription["status"] enum is narrower than Stripe's. Statuses
// with no 1:1 mapping are surfaced as their own divergence category rather
// than silently forced into the nearest guess.
const STRIPE_TO_OUR_STATUS: Record<string, string | undefined> = {
  trialing: "trialing",
  active: "active",
  canceled: "canceled",
  past_due: "past_due",
  incomplete: "incomplete",
  // No mapping — flagged as UNMAPPED if encountered:
  incomplete_expired: undefined,
  unpaid: undefined,
  paused: undefined,
};

interface DivergenceRow {
  subscriptionRowId: string;
  userId: string;
  stripeSubscriptionId: string;
  divergences: string[];
}

async function main() {
  const keyMode = process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")
    ? "LIVE"
    : process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_")
      ? "TEST"
      : "UNKNOWN";
  console.log(`\n=== Stripe subscription reconciliation (key mode: ${keyMode}) ===\n`);
  if (keyMode !== "LIVE") {
    console.log(
      "⚠️  STRIPE_SECRET_KEY is not a live-mode (sk_live_) key. Real subscribers'\n" +
        "    subscriptions live in Stripe live mode — a test-mode key cannot see them\n" +
        "    at all (every lookup below will 404 as \"No such subscription\", not a\n" +
        "    meaningful divergence). This is expected and NOT a bug in this script if\n" +
        "    you're intentionally running against test data; otherwise, sync the live\n" +
        "    STRIPE_SECRET_KEY from Render before trusting this output.\n",
    );
  }

  const { data: rows, error } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, user_id, plan, status, stripe_subscription_id, stripe_customer_id, current_period_end, cancel_requested_at, trial_ends_at",
    )
    .eq("platform", "stripe");
  if (error) throw error;

  console.log(`Found ${rows.length} subscriptions row(s) with platform='stripe'.\n`);

  const divergent: DivergenceRow[] = [];
  const unreachable: { subscriptionRowId: string; userId: string; stripeSubscriptionId: string; reason: string }[] = [];

  for (const row of rows) {
    if (!row.stripe_subscription_id) {
      unreachable.push({
        subscriptionRowId: row.id,
        userId: row.user_id,
        stripeSubscriptionId: "(null)",
        reason: "platform='stripe' row has no stripe_subscription_id",
      });
      continue;
    }

    let liveSub: any;
    try {
      liveSub = await stripe.subscriptions.retrieve(row.stripe_subscription_id);
    } catch (err: any) {
      unreachable.push({
        subscriptionRowId: row.id,
        userId: row.user_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        reason: err?.message ?? "Unknown Stripe API error",
      });
      continue;
    }

    const divergences: string[] = [];

    const mappedStatus = STRIPE_TO_OUR_STATUS[liveSub.status];
    if (mappedStatus === undefined) {
      divergences.push(
        `UNMAPPED Stripe status '${liveSub.status}' has no equivalent in our status enum — needs a product decision, not an auto-map`,
      );
    } else if (mappedStatus !== row.status) {
      divergences.push(`status: DB='${row.status}' vs Stripe='${liveSub.status}' (mapped='${mappedStatus}')`);
    }

    const livePeriodEnd = extractPeriodEnd(liveSub);
    if (livePeriodEnd && row.current_period_end) {
      const dbMs = new Date(row.current_period_end).getTime();
      const liveMs = new Date(livePeriodEnd).getTime();
      // Allow a small tolerance for representation differences, not real drift.
      if (Math.abs(dbMs - liveMs) > 60_000) {
        divergences.push(`current_period_end: DB='${row.current_period_end}' vs Stripe='${livePeriodEnd}'`);
      }
    } else if (livePeriodEnd !== (row.current_period_end ?? null)) {
      divergences.push(`current_period_end: DB='${row.current_period_end}' vs Stripe='${livePeriodEnd}'`);
    }

    const dbHasCancelIntent = row.cancel_requested_at !== null;
    if (liveSub.cancel_at_period_end !== dbHasCancelIntent) {
      divergences.push(
        `cancel intent: DB cancel_requested_at ${dbHasCancelIntent ? "SET" : "null"} vs Stripe cancel_at_period_end=${liveSub.cancel_at_period_end}`,
      );
    }

    if (divergences.length > 0) {
      divergent.push({
        subscriptionRowId: row.id,
        userId: row.user_id,
        stripeSubscriptionId: row.stripe_subscription_id,
        divergences,
      });
    }
  }

  console.log("─".repeat(78));
  console.log(`DIVERGENT (${divergent.length}):\n`);
  for (const d of divergent) {
    console.log(`  subscriptions.id=${d.subscriptionRowId}  user_id=${d.userId}  stripe_subscription_id=${d.stripeSubscriptionId}`);
    for (const line of d.divergences) console.log(`    - ${line}`);
    console.log("");
  }

  console.log("─".repeat(78));
  console.log(`UNREACHABLE / LOOKUP FAILED (${unreachable.length}):\n`);
  for (const u of unreachable) {
    console.log(`  subscriptions.id=${u.subscriptionRowId}  user_id=${u.userId}  stripe_subscription_id=${u.stripeSubscriptionId}`);
    console.log(`    - ${u.reason}\n`);
  }

  console.log("─".repeat(78));
  console.log(
    `\nSummary: ${rows.length} row(s) checked, ${divergent.length} diverged, ${unreachable.length} unreachable, ${
      rows.length - divergent.length - unreachable.length
    } clean.\n`,
  );
  console.log("No writes were made. Fix rows only after review.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

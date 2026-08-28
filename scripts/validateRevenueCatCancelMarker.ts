// scripts/validateRevenueCatCancelMarker.ts
//
// Gate for the RevenueCat CANCELLATION handler change (FEEDBACK_DESIGN.md
// Phase 2 / §3.3): scoped EXACTLY as designed — a pending-feedback marker
// only, zero access/status/entitlement changes. Asserts access survives
// through period end, per the brief's explicit requirement.
//
// No real App Store/RevenueCat call needed — RevenueCat webhooks are just
// JSON, so this calls handleRevenueCatEvent() directly with synthetic event
// bodies against one disposable Supabase user + a synthetic 'apple'
// subscriptions row, created and torn down within the run.
//
// Also proves the comp-exclusion defense: a platform='comp' row given the
// same cancel_requested_at value directly (bypassing every normal code path,
// which never targets comp rows) still reads as NOT pending — the
// getFlowB2GateState() query's own `.neq("platform","comp")` filter, not
// just "no code path happens to write it".
//
// REQUIRES: migrations/2026-08-28_subscriptions_cancel_requested_at.sql AND
// migrations/2026-08-28_product_feedback.sql both applied first.
//
// Usage: npx ts-node scripts/validateRevenueCatCancelMarker.ts
//        (or: node scripts/validateRevenueCatCancelMarker.ts on Node >= 22,
//        which strips types natively)

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { handleRevenueCatEvent } from "../src/services/revenuecat.service";
import { resolvePlan } from "../src/services/plan.service";
import { getFlowB2GateState } from "../src/repositories/productFeedback.repository";

const TAG = `qa-rc-cancel-marker-${Date.now()}`;
const TEST_EMAIL = `${TAG}@example.com`;
const PROVIDER_ID = `rc-orig-txn-${TAG}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  console.log(`\n=== RevenueCat cancel-marker validation (${TAG}) ===\n`);

  const { data: userData, error: userErr } = await supabaseAdmin.auth.admin.createUser({
    email: TEST_EMAIL,
    password: `Test-${Math.random().toString(36).slice(2)}Aa1!`,
    email_confirm: true,
    user_metadata: { qa_disposable: true, tag: TAG },
  });
  if (userErr || !userData?.user) throw userErr ?? new Error("createUser returned no user");
  const userId = userData.user.id;

  const periodEndMs = Date.now() + 3 * 86_400_000;

  const { error: subErr } = await supabaseAdmin.from("subscriptions").insert({
    user_id: userId,
    platform: "apple",
    plan: "collector",
    status: "active",
    rc_app_user_id: userId,
    provider_subscription_id: PROVIDER_ID,
    current_period_end: new Date(periodEndMs).toISOString(),
  });
  if (subErr) throw subErr;

  // Second, unrelated disposable user for the comp-exclusion check.
  const { data: compUserData, error: compUserErr } = await supabaseAdmin.auth.admin.createUser({
    email: `${TAG}-comp@example.com`,
    password: `Test-${Math.random().toString(36).slice(2)}Aa1!`,
    email_confirm: true,
    user_metadata: { qa_disposable: true, tag: TAG },
  });
  if (compUserErr || !compUserData?.user) throw compUserErr ?? new Error("createUser (comp) returned no user");
  const compUserId = compUserData.user.id;
  const { error: compSubErr } = await supabaseAdmin.from("subscriptions").insert({
    user_id: compUserId,
    platform: "comp",
    plan: "pro",
    status: "active",
  });
  if (compSubErr) throw compSubErr;

  try {
    // ─── State 1: baseline, before any cancellation ─────────────────────────
    console.log("State 1 — baseline, before cancellation:");
    const plan1 = await resolvePlan(userId);
    check("has paid plan access", plan1.plan === "collector", `plan=${plan1.plan}`);
    const b2State1 = await getFlowB2GateState(userId);
    check("no pending B2 ask yet", !b2State1.pending);

    // ─── State 2: CANCELLATION webhook event ────────────────────────────────
    console.log("\nState 2 — CANCELLATION event (real handleRevenueCatEvent()):");
    await handleRevenueCatEvent({
      event: {
        type: "CANCELLATION",
        app_user_id: userId,
        original_transaction_id: PROVIDER_ID,
        product_id: "collector",
        expiration_at_ms: periodEndMs,
        store: "APP_STORE",
        period_type: "NORMAL", // paid, not trial
      },
    });

    const plan2 = await resolvePlan(userId);
    check("access intact after CANCELLATION event", plan2.plan === "collector", `plan=${plan2.plan}`);

    const { data: row2 } = await supabaseAdmin
      .from("subscriptions")
      .select("status, cancel_requested_at, was_trial_at_cancel")
      .eq("provider_subscription_id", PROVIDER_ID)
      .single();
    check("status untouched", row2?.status === "active", `status=${row2?.status}`);
    check("cancel_requested_at now set", !!row2?.cancel_requested_at);
    check("was_trial_at_cancel correctly false (period_type=NORMAL)", row2?.was_trial_at_cancel === false);

    const b2State2 = await getFlowB2GateState(userId);
    check("Flow B2 pending marker now true", b2State2.pending);
    check("wasTrial surfaced correctly", b2State2.wasTrial === false);

    // ─── State 3: true expiration ────────────────────────────────────────────
    console.log("\nState 3 — EXPIRATION event:");
    await handleRevenueCatEvent({
      event: {
        type: "EXPIRATION",
        app_user_id: userId,
        original_transaction_id: PROVIDER_ID,
        product_id: "collector",
        expiration_at_ms: periodEndMs,
        store: "APP_STORE",
      },
    });
    const plan3 = await resolvePlan(userId);
    check("access revoked at true expiration", plan3.plan === "starter", `plan=${plan3.plan}`);

    const { data: row3 } = await supabaseAdmin
      .from("subscriptions")
      .select("cancel_requested_at")
      .eq("provider_subscription_id", PROVIDER_ID)
      .single();
    check("cancel_requested_at left as-is, not cleared", !!row3?.cancel_requested_at);

    // ─── State 4: resubscribe (INITIAL_PURCHASE) clears the cluster ─────────
    console.log("\nState 4 — resubscribe (INITIAL_PURCHASE):");
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: userId,
        original_transaction_id: PROVIDER_ID,
        product_id: "collector",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        store: "APP_STORE",
        period_type: "NORMAL",
      },
    });
    const b2State4 = await getFlowB2GateState(userId);
    check("Flow B2 marker cleared on resubscribe", !b2State4.pending);
    const plan4 = await resolvePlan(userId);
    check("access restored", plan4.plan === "collector", `plan=${plan4.plan}`);

    // ─── comp exclusion — defensive filter, not just "no writer" ───────────
    console.log("\nComp exclusion (defensive filter):");
    await supabaseAdmin
      .from("subscriptions")
      .update({ cancel_requested_at: new Date().toISOString() })
      .eq("user_id", compUserId);
    const compB2State = await getFlowB2GateState(compUserId);
    check(
      "comp row with cancel_requested_at set still reads as NOT pending",
      !compB2State.pending,
    );
  } finally {
    console.log("\nCleaning up disposable test resources…");
    await supabaseAdmin.from("subscriptions").delete().eq("user_id", userId);
    await supabaseAdmin.from("subscriptions").delete().eq("user_id", compUserId);
    await supabaseAdmin.auth.admin.deleteUser(userId);
    await supabaseAdmin.auth.admin.deleteUser(compUserId);
    console.log("  done.");
  }

  console.log(
    failures === 0
      ? "\n✅ PASS — RevenueCat cancel-marker change is scoped correctly\n"
      : `\n❌ FAIL — ${failures} assertion(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

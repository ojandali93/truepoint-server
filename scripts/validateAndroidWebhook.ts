// scripts/validateAndroidWebhook.ts
//
// Gate for Android webhook wiring (launch precondition, ruled first-task):
// the RevenueCat handler used to drop every non-APP_STORE event outright
// and upsertAppleSubscription (now upsertRevenueCatSubscription)
// hardcoded platform:'apple' — Play subscriptions were never recorded
// server-side, at all, ever. This replays representative PLAY_STORE
// fixture events through the real handleRevenueCatEvent() (same pattern
// as validateRevenueCatCancelMarker.ts — RevenueCat webhooks are just
// JSON, no real Play Store/RevenueCat call needed) against disposable
// Supabase users, and tears everything down at the end.
//
// Covers, per the gate:
//   1. Full PLAY_STORE lifecycle (initial purchase, renewal,
//      cancellation-marker, expiration) writes platform='google' rows
//      with correct plan/status transitions.
//   2. The verbatim "pro-montly" Play base-plan typo (AS-CREATED on
//      Google Play Console, not introduced by this codebase — see
//      revenuecat.service.ts's PRODUCT_TO_PLAN comment) resolves to the
//      right plan, unmodified.
//   3. An unrecognized/missing store is skipped, not silently defaulted
//      to Apple.
//   4. Grandfather comp-deactivation and the "any remaining real
//      subscription" check are platform-agnostic: a lone Play
//      subscription's expiration deactivates a comp grant exactly like
//      an Apple one would; a Play expiration does NOT deactivate a comp
//      grant when a Stripe subscription is still active for the same
//      user (cross-platform "other real sub" detection, not just
//      "google behaves like apple in isolation").
//
// Usage: npx ts-node scripts/validateAndroidWebhook.ts
//        (or: node scripts/validateAndroidWebhook.ts on Node >= 22,
//        which strips types natively)

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { handleRevenueCatEvent } from "../src/services/revenuecat.service";
import { resolvePlan } from "../src/services/plan.service";

const TAG = `qa-android-webhook-${Date.now()}`;

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✅" : "❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function createDisposableUser(suffix: string): Promise<string> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `${TAG}-${suffix}@example.com`,
    password: `Test-${Math.random().toString(36).slice(2)}Aa1!`,
    email_confirm: true,
    user_metadata: { qa_disposable: true, tag: TAG },
  });
  if (error || !data?.user) {
    throw error ?? new Error(`createUser(${suffix}) returned no user`);
  }
  return data.user.id;
}

async function main() {
  console.log(`\n=== Android webhook wiring validation (${TAG}) ===\n`);

  const cleanupUserIds: string[] = [];

  try {
    // ─── 1. Full PLAY_STORE lifecycle on one user ──────────────────────────
    console.log("Scenario 1 — full PLAY_STORE lifecycle:");
    const u1 = await createDisposableUser("lifecycle");
    cleanupUserIds.push(u1);
    const providerId1 = `rc-orig-txn-${TAG}-1`;

    // INITIAL_PURCHASE — the verbatim Play base-plan typo product id.
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u1,
        original_transaction_id: providerId1,
        product_id: "pro_monthly_1499:pro-montly", // verbatim, do not "fix"
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    const { data: row1a } = await supabaseAdmin
      .from("subscriptions")
      .select("platform, plan, status")
      .eq("provider_subscription_id", providerId1)
      .single();
    check(
      "INITIAL_PURCHASE writes platform='google'",
      row1a?.platform === "google",
      `platform=${row1a?.platform}`,
    );
    check(
      "verbatim 'pro-montly' base-plan id resolves to plan='pro'",
      row1a?.plan === "pro",
      `plan=${row1a?.plan}`,
    );
    check("status active (non-trial)", row1a?.status === "active", `status=${row1a?.status}`);

    const plan1a = await resolvePlan(u1);
    check("resolvePlan sees the google row", plan1a.plan === "pro", `plan=${plan1a.plan}`);
    check("resolvePlan reports platform='google'", plan1a.platform === "google", `platform=${plan1a.platform}`);

    // RENEWAL — new period end, still active.
    const renewedEndMs = Date.now() + 60 * 86_400_000;
    await handleRevenueCatEvent({
      event: {
        type: "RENEWAL",
        app_user_id: u1,
        original_transaction_id: providerId1,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: renewedEndMs,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    const { data: row1b } = await supabaseAdmin
      .from("subscriptions")
      .select("status, current_period_end")
      .eq("provider_subscription_id", providerId1)
      .single();
    check("RENEWAL keeps status active", row1b?.status === "active", `status=${row1b?.status}`);
    check(
      "RENEWAL extends current_period_end",
      !!row1b?.current_period_end &&
        new Date(row1b.current_period_end).getTime() === renewedEndMs,
      `current_period_end=${row1b?.current_period_end}`,
    );

    // CANCELLATION — marker only, access continues (same contract as Apple).
    await handleRevenueCatEvent({
      event: {
        type: "CANCELLATION",
        app_user_id: u1,
        original_transaction_id: providerId1,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: renewedEndMs,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    const { data: row1c } = await supabaseAdmin
      .from("subscriptions")
      .select("status, cancel_requested_at")
      .eq("provider_subscription_id", providerId1)
      .single();
    check(
      "CANCELLATION leaves status active (access continues)",
      row1c?.status === "active",
      `status=${row1c?.status}`,
    );
    check("CANCELLATION sets cancel_requested_at", !!row1c?.cancel_requested_at);
    const plan1c = await resolvePlan(u1);
    check("access intact after CANCELLATION marker", plan1c.plan === "pro", `plan=${plan1c.plan}`);

    // EXPIRATION — true terminal event.
    await handleRevenueCatEvent({
      event: {
        type: "EXPIRATION",
        app_user_id: u1,
        original_transaction_id: providerId1,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: renewedEndMs,
        store: "PLAY_STORE",
      },
    });
    const { data: row1d } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("provider_subscription_id", providerId1)
      .single();
    check("EXPIRATION sets status canceled", row1d?.status === "canceled", `status=${row1d?.status}`);
    const plan1d = await resolvePlan(u1);
    check("access revoked at true expiration", plan1d.plan === "starter", `plan=${plan1d.plan}`);

    // Annual base-plan id, no typo — sanity check the map's other Play entry.
    console.log("\nScenario 1b — annual Play base-plan id (no typo, sanity check):");
    const providerId1b = `rc-orig-txn-${TAG}-1b`;
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u1,
        original_transaction_id: providerId1b,
        product_id: "pro_annual_12999:pro-annual",
        expiration_at_ms: Date.now() + 365 * 86_400_000,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    const { data: row1e } = await supabaseAdmin
      .from("subscriptions")
      .select("platform, plan")
      .eq("provider_subscription_id", providerId1b)
      .single();
    check(
      "annual Play base-plan id resolves to plan='pro', platform='google'",
      row1e?.plan === "pro" && row1e?.platform === "google",
      `plan=${row1e?.plan} platform=${row1e?.platform}`,
    );

    // ─── 2. Unrecognized/missing store is skipped, not defaulted ──────────
    console.log("\nScenario 2 — unrecognized store is skipped (not defaulted to apple):");
    const providerId2 = `rc-orig-txn-${TAG}-2`;
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u1,
        original_transaction_id: providerId2,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        store: "AMAZON", // not one of the two handled stores
        period_type: "NORMAL",
      },
    });
    const { data: row2 } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("provider_subscription_id", providerId2)
      .maybeSingle();
    check("unrecognized store writes no row", !row2);

    const providerId2b = `rc-orig-txn-${TAG}-2b`;
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u1,
        original_transaction_id: providerId2b,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        // store omitted entirely
        period_type: "NORMAL",
      } as any,
    });
    const { data: row2c } = await supabaseAdmin
      .from("subscriptions")
      .select("id")
      .eq("provider_subscription_id", providerId2b)
      .maybeSingle();
    check("missing store writes no row (not silently defaulted to apple)", !row2c);

    // ─── 3. Grandfather comp-deactivation, platform-agnostic ───────────────
    console.log("\nScenario 3 — comp-deactivation fires for a lone Play subscription:");
    const u2 = await createDisposableUser("comp-google-only");
    cleanupUserIds.push(u2);
    const { error: comp2Err } = await supabaseAdmin.from("subscriptions").insert({
      user_id: u2,
      platform: "comp",
      plan: "pro",
      status: "active",
    });
    if (comp2Err) throw comp2Err;
    const providerId3 = `rc-orig-txn-${TAG}-3`;
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u2,
        original_transaction_id: providerId3,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    await handleRevenueCatEvent({
      event: {
        type: "EXPIRATION",
        app_user_id: u2,
        original_transaction_id: providerId3,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now(),
        store: "PLAY_STORE",
      },
    });
    const { data: compRow3 } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", u2)
      .eq("platform", "comp")
      .single();
    check(
      "comp grant deactivated when the only real sub (google) expires",
      compRow3?.status === "canceled",
      `status=${compRow3?.status}`,
    );

    console.log("\nScenario 4 — comp-deactivation does NOT fire when another real sub survives:");
    const u3 = await createDisposableUser("comp-cross-platform");
    cleanupUserIds.push(u3);
    const { error: comp3Err } = await supabaseAdmin.from("subscriptions").insert({
      user_id: u3,
      platform: "comp",
      plan: "pro",
      status: "active",
    });
    if (comp3Err) throw comp3Err;
    const { error: stripeErr } = await supabaseAdmin.from("subscriptions").insert({
      user_id: u3,
      platform: "stripe",
      plan: "collector",
      status: "active",
      stripe_customer_id: `cus_${TAG}`,
      stripe_subscription_id: `sub_${TAG}`,
    });
    if (stripeErr) throw stripeErr;
    const providerId4 = `rc-orig-txn-${TAG}-4`;
    await handleRevenueCatEvent({
      event: {
        type: "INITIAL_PURCHASE",
        app_user_id: u3,
        original_transaction_id: providerId4,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now() + 30 * 86_400_000,
        store: "PLAY_STORE",
        period_type: "NORMAL",
      },
    });
    await handleRevenueCatEvent({
      event: {
        type: "EXPIRATION",
        app_user_id: u3,
        original_transaction_id: providerId4,
        product_id: "pro_monthly_1499:pro-montly",
        expiration_at_ms: Date.now(),
        store: "PLAY_STORE",
      },
    });
    const { data: compRow4 } = await supabaseAdmin
      .from("subscriptions")
      .select("status")
      .eq("user_id", u3)
      .eq("platform", "comp")
      .single();
    check(
      "comp grant survives — Stripe row is still active elsewhere for the same user",
      compRow4?.status === "active",
      `status=${compRow4?.status}`,
    );
  } finally {
    console.log("\nCleaning up disposable test resources…");
    for (const id of cleanupUserIds) {
      await supabaseAdmin.from("subscriptions").delete().eq("user_id", id);
      await supabaseAdmin.auth.admin.deleteUser(id);
    }
    console.log("  done.");
  }

  console.log(
    failures === 0
      ? "\n✅ PASS — Android webhook wiring is correct\n"
      : `\n❌ FAIL — ${failures} assertion(s) failed\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

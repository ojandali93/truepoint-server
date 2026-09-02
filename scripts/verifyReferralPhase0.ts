// verifyReferralPhase0.ts
//
// Phase 0 gate (AUDITS/referral-program-plan.md §9): "migrations applied
// and verified via live read-back; a throwaway comp row tagged
// comp_reason='referral_reward' survives a real customer.subscription.
// deleted-equivalent event fired against an unrelated real subscription on
// the same test user — proving Finding 1's fix actually closes the
// collision, not just that the column exists."
//
// Two parts:
//   1. Read-back: the new tables/columns exist, the comp_reason backfill
//      landed correctly (cross-checked against Omar's own report: 4
//      grandfather, 10 admin_grant, zero NULL among comp rows).
//   2. The real behavioral gate: creates a throwaway user with BOTH a real
//      'apple' row and a comp_reason='referral_reward' row, then calls the
//      REAL deactivateGrandfatherCompIfNoRealSubRemains — the exact
//      function billing.service.ts's customer.subscription.deleted and
//      revenuecat.service.ts's EXPIRATION handlers call — after the real
//      row reaches a terminal state, and asserts the referral-reward comp
//      row is untouched. This is the actual fix, exercised end to end, not
//      just a schema check.
//
// Run: npx ts-node scripts/verifyReferralPhase0.ts

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { deactivateGrandfatherCompIfNoRealSubRemains } from "../src/services/adminPlatform.service";

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
  console.log("=== Part 1: read-back ===");

  const { error: codesErr } = await supabaseAdmin.from("referral_codes").select("id").limit(1);
  assertTrue("referral_codes table exists", !codesErr, codesErr?.message);

  const { error: rewardsErr } = await supabaseAdmin.from("referral_rewards").select("id").limit(1);
  assertTrue("referral_rewards table exists", !rewardsErr, rewardsErr?.message);

  const { error: attrErr } = await supabaseAdmin
    .from("referral_attributions")
    .select("id, attribution_type, referrer_user_id")
    .limit(1);
  assertTrue("referral_attributions.attribution_type/referrer_user_id exist", !attrErr, attrErr?.message);

  const { count: resolvedCount } = await supabaseAdmin
    .from("referral_attributions")
    .select("id", { count: "exact", head: true })
    .eq("resolved", true);
  const { count: affiliateTypedCount } = await supabaseAdmin
    .from("referral_attributions")
    .select("id", { count: "exact", head: true })
    .eq("resolved", true)
    .eq("attribution_type", "affiliate");
  assertTrue(
    "every resolved referral_attributions row backfilled as attribution_type='affiliate'",
    resolvedCount === affiliateTypedCount,
    { resolvedCount, affiliateTypedCount },
  );

  const { count: grandfatherCount } = await supabaseAdmin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("platform", "comp")
    .eq("comp_reason", "grandfather");
  const { count: adminGrantCount } = await supabaseAdmin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("platform", "comp")
    .eq("comp_reason", "admin_grant");
  const { count: nullReasonCount } = await supabaseAdmin
    .from("subscriptions")
    .select("id", { count: "exact", head: true })
    .eq("platform", "comp")
    .is("comp_reason", null);
  console.log(`  comp_reason backfill: grandfather=${grandfatherCount}, admin_grant=${adminGrantCount}, null=${nullReasonCount}`);
  assertTrue("4 grandfather rows (matches your own report)", grandfatherCount === 4, grandfatherCount);
  assertTrue("10 admin_grant rows (matches your own report)", adminGrantCount === 10, adminGrantCount);
  assertTrue("zero comp rows with a null comp_reason", nullReasonCount === 0, nullReasonCount);

  const { data: grandfatherRows } = await supabaseAdmin
    .from("subscriptions")
    .select("id, rc_app_user_id, provider_subscription_id")
    .eq("comp_reason", "grandfather");
  const identifierRefreshApplied = (grandfatherRows ?? []).every(
    (r) => r.rc_app_user_id === null && r.provider_subscription_id === null,
  );
  console.log(
    `  grandfather rows' identifier-refresh (58ca84d) status: ${identifierRefreshApplied ? "applied" : "NOT YET applied — separate migration, run at your own pace"}`,
  );

  console.log("\n=== Part 2: the real behavioral gate ===");
  let userId: string | null = null;
  try {
    const stamp = Date.now();
    const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: `phase0-gate+${stamp}@reverseholo.io`,
      password: `gate-${stamp}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    if (authErr || !authUser?.user) throw authErr ?? new Error("no user");
    userId = authUser.user.id;
    console.log(`  throwaway user: ${userId}`);

    // A real 'apple' row, active — the "unrelated real subscription" the
    // referral-reward comp grant must survive the loss of.
    await supabaseAdmin.from("subscriptions").insert({
      user_id: userId,
      platform: "apple",
      plan: "collector",
      status: "active",
      rc_app_user_id: userId,
      provider_subscription_id: `TEST_GATE_REAL_${stamp}`,
    });

    // The referral-reward comp grant under test.
    const { data: compRow } = await supabaseAdmin
      .from("subscriptions")
      .insert({
        user_id: userId,
        platform: "comp",
        comp_reason: "referral_reward",
        plan: "pro",
        status: "active",
        current_period_end: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
      })
      .select("id, status")
      .single();
    console.log(`  referral_reward comp row: ${compRow?.id}, status: ${compRow?.status}`);

    // Simulate the real subscription reaching a terminal state — exactly
    // what billing.service.ts's customer.subscription.deleted and
    // revenuecat.service.ts's EXPIRATION handlers do before calling
    // deactivateGrandfatherCompIfNoRealSubRemains.
    await supabaseAdmin
      .from("subscriptions")
      .update({ status: "canceled" })
      .eq("user_id", userId)
      .eq("platform", "apple");

    // The real function under test.
    await deactivateGrandfatherCompIfNoRealSubRemains(userId);

    const { data: afterRow } = await supabaseAdmin
      .from("subscriptions")
      .select("id, status, comp_reason")
      .eq("id", compRow!.id)
      .single();
    console.log(`  referral_reward comp row after: ${JSON.stringify(afterRow)}`);
    assertTrue(
      "referral_reward comp row survives — still active, untouched by the deactivation call",
      afterRow?.status === "active",
      afterRow,
    );

    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  } finally {
    if (userId) {
      await supabaseAdmin.from("subscriptions").delete().eq("user_id", userId);
      await supabaseAdmin.auth.admin.deleteUser(userId);
      console.log(`\n  cleaned up throwaway user ${userId}`);
    }
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

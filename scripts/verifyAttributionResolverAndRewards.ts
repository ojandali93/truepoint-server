// verifyAttributionResolverAndRewards.ts
//
// Live gate for the frontend build (affiliate + referral programs, both
// flags OFF by default): the CRITICAL requirement was "the flag must gate
// BEHAVIOR, not just UI." This proves it two ways against the real DB:
//
//   Part 1 — flags OFF (the real, current, no-rows-created-yet state,
//   which fails closed per evaluateFlag()'s own documented behavior):
//   resolveAttribution writes ZERO rows for a real code against a real
//   user. This is the literal meaning of "a non-allowlisted user's signup
//   flow is byte-identical to today's" at the data layer.
//
//   Part 2 — flags ON (a TEMPORARY allowlist row, scoped to a throwaway
//   test user, created and deleted by this script — not a persistent
//   change; Omar creates the real flags himself, per his own request for
//   exact admin steps): the resolver's precedence (affiliate slug before
//   referral code), self-referral block, welcome bonus grant, first-
//   grading qualification, and reward grant/stacking all work end to end
//   against the live DB and the real service functions.
//
// Run: npx ts-node scripts/verifyAttributionResolverAndRewards.ts

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { resolveAttribution } from "../src/services/attribution.service";
import {
  recordReferralQualification,
  getReferralSummary,
} from "../src/services/referralReward.service";
import { invalidateFlagCache } from "../src/services/featureFlag.service";

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

async function createThrowawayUser(label: string): Promise<string> {
  const stamp = Date.now() + Math.random();
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `verify-${label}+${stamp}@reverseholo.io`,
    password: `v-${stamp}-${Math.random().toString(36).slice(2)}`,
    email_confirm: true,
  });
  if (error || !data?.user) throw error ?? new Error(`createUser failed for ${label}`);
  return data.user.id;
}

async function main() {
  const createdUserIds: string[] = [];
  let tempFlagIds: string[] = [];

  try {
    // ── Part 1: flags OFF (real current state) ────────────────────────────
    console.log("=== Part 1: flags OFF — behavior, not just UI ===");
    const offUser = await createThrowawayUser("flags-off");
    createdUserIds.push(offUser);

    const { data: existingFlags } = await supabaseAdmin
      .from("feature_flags")
      .select("key")
      .in("key", ["affiliate_program", "referral_program"]);
    assertTrue(
      "neither flag has a row yet (fails closed per evaluateFlag's own documented behavior)",
      (existingFlags ?? []).length === 0,
      existingFlags,
    );

    const offResult = await resolveAttribution({
      userId: offUser,
      rawCode: "SOME-REAL-LOOKING-CODE",
      source: "web_manual",
      role: null,
    });
    assertTrue("resolver returns flags_off", offResult.outcome === "flags_off", offResult);

    const { count: attrRowCount } = await supabaseAdmin
      .from("referral_attributions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", offUser);
    assertTrue("ZERO referral_attributions rows written for the flags-off user", attrRowCount === 0, attrRowCount);

    // ── Part 2: flags ON (temporary allowlist, cleaned up after) ──────────
    console.log("\n=== Part 2: flags ON — full resolver + reward path ===");
    const { data: aff, error: affErr } = await supabaseAdmin
      .from("affiliates")
      .insert({
        name: `Resolver Verify ${Date.now()}`,
        slug: `resolver-verify-${Date.now()}`,
        type: "vendor",
        active: true,
        commission_rate: 0.2,
        commission_window_months: 12,
      })
      .select("id, slug")
      .single();
    if (affErr || !aff) throw affErr ?? new Error("affiliate insert failed");

    const referrer = await createThrowawayUser("referrer");
    createdUserIds.push(referrer);
    const referredFriend = await createThrowawayUser("referred-friend");
    createdUserIds.push(referredFriend);
    const affiliateSignup = await createThrowawayUser("affiliate-signup");
    createdUserIds.push(affiliateSignup);
    const selfReferralUser = referrer; // reuses their own code on themselves

    const allowlist = [referrer, referredFriend, affiliateSignup, offUser];
    const { data: flagRows, error: flagErr } = await supabaseAdmin
      .from("feature_flags")
      .insert([
        {
          key: "affiliate_program",
          enabled: true,
          audience: "allowlist",
          allowed_user_ids: allowlist,
          description: "[TEMP TEST ROW — verifyAttributionResolverAndRewards.ts, deleted at end of run]",
        },
        {
          key: "referral_program",
          enabled: true,
          audience: "allowlist",
          allowed_user_ids: allowlist,
          description: "[TEMP TEST ROW — verifyAttributionResolverAndRewards.ts, deleted at end of run]",
        },
      ])
      .select("id");
    if (flagErr || !flagRows) throw flagErr ?? new Error("temp flag insert failed");
    tempFlagIds = flagRows.map((r) => r.id);
    invalidateFlagCache();

    // Affiliate code resolves as affiliate, not referral (precedence).
    const affResult = await resolveAttribution({
      userId: affiliateSignup,
      rawCode: aff.slug,
      source: "web_manual",
      role: null,
    });
    assertTrue("affiliate slug resolves as resolved_affiliate", affResult.outcome === "resolved_affiliate", affResult);

    // Referrer generates their own code (going through the real lazy-gen
    // path a client would call).
    const { getOrCreateReferralCode } = await import("../src/services/referralReward.service");
    const referrerCode = await getOrCreateReferralCode(referrer);
    assertTrue("referral code generated", typeof referrerCode === "string" && referrerCode.length > 0, referrerCode);

    // Self-referral block.
    const selfResult = await resolveAttribution({
      userId: selfReferralUser,
      rawCode: referrerCode,
      source: "post_signup_grace",
      role: null,
    });
    assertTrue("self-application of own code blocked", selfResult.outcome === "self_referral_blocked", selfResult);

    // Real referral: friend uses referrer's code.
    const refResult = await resolveAttribution({
      userId: referredFriend,
      rawCode: referrerCode,
      source: "web_cookie",
      role: null,
    });
    assertTrue("referral code resolves as resolved_referral", refResult.outcome === "resolved_referral", refResult);

    // Welcome bonus — a comp_reason='referral_welcome' row for the friend.
    const { data: welcomeRow } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan, status, comp_reason, current_period_end")
      .eq("user_id", referredFriend)
      .eq("comp_reason", "referral_welcome")
      .maybeSingle();
    assertTrue("referred friend got a 7-day Pro welcome bonus", !!welcomeRow && welcomeRow.plan === "pro", welcomeRow);

    // "First one wins" — a second code attempt for the same user is a no-op.
    const secondAttempt = await resolveAttribution({
      userId: referredFriend,
      rawCode: aff.slug,
      source: "post_signup_grace",
      role: null,
    });
    assertTrue("second attribution attempt is a no-op (already_attributed)", secondAttempt.outcome === "already_attributed", secondAttempt);

    // Qualification: friend's first completed AI grading report.
    const { data: report, error: reportErr } = await supabaseAdmin
      .from("ai_grading_reports")
      .insert({ user_id: referredFriend, status: "completed" })
      .select("id")
      .single();
    if (reportErr || !report) throw reportErr ?? new Error("report insert failed");

    const qualResult = await recordReferralQualification(referredFriend, report.id);
    assertTrue(
      "qualification grants the reward immediately (under cap)",
      qualResult.outcome === "qualified_and_granted",
      qualResult,
    );

    const summary = await getReferralSummary(referrer);
    assertTrue("referrer's summary shows 1 referred, 1 qualified", summary.referredCount === 1 && summary.qualifiedCount === 1, summary);
    assertTrue("referrer's summary shows 1 granted month this year", summary.grantedMonthsThisYear === 1, summary);
    assertTrue("reward history has exactly 1 entry, status granted", summary.rewards.length === 1 && summary.rewards[0].status === "granted", summary.rewards);

    const { data: rewardRow } = await supabaseAdmin
      .from("subscriptions")
      .select("id, plan, status, comp_reason, current_period_end")
      .eq("user_id", referrer)
      .eq("comp_reason", "referral_reward")
      .maybeSingle();
    assertTrue("referrer got a referral_reward comp Pro row", !!rewardRow && rewardRow.plan === "pro", rewardRow);

    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);

    // Cleanup order matters: children before parents.
    await supabaseAdmin.from("ai_grading_reports").delete().eq("id", report.id);
  } finally {
    console.log("\n=== Cleanup ===");
    if (tempFlagIds.length > 0) {
      await supabaseAdmin.from("feature_flags").delete().in("id", tempFlagIds);
      invalidateFlagCache();
      console.log(`  deleted ${tempFlagIds.length} temporary flag row(s)`);
    }
    for (const userId of createdUserIds) {
      await supabaseAdmin.from("referral_rewards").delete().eq("referrer_user_id", userId);
      await supabaseAdmin.from("referral_rewards").delete().eq("referred_user_id", userId);
      await supabaseAdmin.from("subscriptions").delete().eq("user_id", userId);
      await supabaseAdmin.from("referral_attributions").delete().eq("user_id", userId);
      await supabaseAdmin.from("referral_codes").delete().eq("user_id", userId);
      await supabaseAdmin.auth.admin.deleteUser(userId);
    }
    console.log(`  deleted ${createdUserIds.length} throwaway user(s) and their rows`);
    await supabaseAdmin.from("affiliates").delete().ilike("name", "Resolver Verify%");
    console.log("  deleted the throwaway affiliate row");
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

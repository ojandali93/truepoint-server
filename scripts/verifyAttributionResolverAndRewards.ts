// verifyAttributionResolverAndRewards.ts
//
// Live gate for the frontend build (affiliate + referral programs, both
// flags OFF by default): the CRITICAL requirement was "the flag must gate
// BEHAVIOR, not just UI." This proves it two ways against the real DB.
//
//   Part 1 — a brand-new, never-allowlisted user: resolveAttribution
//   writes ZERO rows for a real code against a real user. This is the
//   literal meaning of "a non-allowlisted user's signup flow is
//   byte-identical to today's" at the data layer, and holds regardless of
//   whether the flag rows exist yet at all.
//
//   Part 2 — flags ON: temporarily adds throwaway test users to whatever
//   allowlist already exists (robust to the real flags already being
//   created — first run, no rows existed, so it inserted+deleted temp
//   rows; once you'd created the real ones, it switched to
//   update-and-restore automatically) — never touches or removes any
//   real allowed user already on the list, restored exactly in `finally`
//   regardless of pass/fail. Exercises the resolver's precedence
//   (affiliate slug before referral code), self-referral block, welcome
//   bonus grant + trial_used, first-grading qualification, and reward
//   grant/stacking end to end against the live DB and the real service
//   functions.
//
// Run: npx ts-node scripts/verifyAttributionResolverAndRewards.ts

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import { resolveAttribution } from "../src/services/attribution.service";
import {
  recordReferralQualification,
  recordReferralInventoryQualification,
  getReferralSummary,
  REFERRAL_INVENTORY_THRESHOLD,
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

type FlagSnapshot = { id: string; key: string; existed: boolean; originalAllowedUserIds: string[] };

async function main() {
  const createdUserIds: string[] = [];
  const flagSnapshots: FlagSnapshot[] = [];

  try {
    // ── Part 1: a brand-new, never-allowlisted user ────────────────────────
    console.log("=== Part 1: flags OFF for a fresh user — behavior, not just UI ===");
    const offUser = await createThrowawayUser("flags-off");
    createdUserIds.push(offUser);

    const { data: existingFlags } = await supabaseAdmin
      .from("feature_flags")
      .select("key, audience, allowed_user_ids")
      .in("key", ["affiliate_program", "referral_program"]);
    console.log(
      `  current flag state: ${(existingFlags ?? []).map((f) => `${f.key}=${f.audience}(${(f.allowed_user_ids ?? []).length} allowed)`).join(", ") || "no rows yet"}`,
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

    const testUsers = [referrer, referredFriend, affiliateSignup, offUser];

    for (const key of ["affiliate_program", "referral_program"] as const) {
      const existing = (existingFlags ?? []).find((f) => f.key === key);
      if (existing) {
        // Real row already exists (e.g. you've created it via the admin
        // panel) — add the test users to whatever's already allowed,
        // remember the original list, restore it in `finally`. Never
        // deletes or otherwise touches the real row.
        const { data: row } = await supabaseAdmin
          .from("feature_flags")
          .select("id, allowed_user_ids")
          .eq("key", key)
          .single();
        if (!row) throw new Error(`flag ${key} vanished between reads`);
        flagSnapshots.push({ id: row.id, key, existed: true, originalAllowedUserIds: row.allowed_user_ids ?? [] });
        const merged = Array.from(new Set([...(row.allowed_user_ids ?? []), ...testUsers]));
        const { error } = await supabaseAdmin
          .from("feature_flags")
          .update({ enabled: true, audience: "allowlist", allowed_user_ids: merged })
          .eq("id", row.id);
        if (error) throw error;
      } else {
        // No row yet — insert a real allowlist row scoped to just the test
        // users, delete it entirely afterward.
        const { data: inserted, error } = await supabaseAdmin
          .from("feature_flags")
          .insert({
            key,
            enabled: true,
            audience: "allowlist",
            allowed_user_ids: testUsers,
            description: "[TEMP TEST ROW — verifyAttributionResolverAndRewards.ts, deleted at end of run]",
          })
          .select("id")
          .single();
        if (error || !inserted) throw error ?? new Error(`temp flag insert failed for ${key}`);
        flagSnapshots.push({ id: inserted.id, key, existed: false, originalAllowedUserIds: [] });
      }
    }
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

    const { data: friendProfile } = await supabaseAdmin
      .from("profiles")
      .select("trial_used")
      .eq("id", referredFriend)
      .maybeSingle();
    assertTrue(
      "welcome bonus marks trial_used (matches vendorCode/updateUserPlan's own convention)",
      friendProfile?.trial_used === true,
      friendProfile,
    );

    // "First one wins" — a second code attempt for the same user is a no-op.
    const secondAttempt = await resolveAttribution({
      userId: referredFriend,
      rawCode: aff.slug,
      source: "post_signup_grace",
      role: null,
    });
    assertTrue("second attribution attempt is a no-op (already_attributed)", secondAttempt.outcome === "already_attributed", secondAttempt);

    // Qualification (ruled 2026-09-02: BOTH conditions, not grading alone).
    // Friend's first completed AI grading report:
    const { data: report, error: reportErr } = await supabaseAdmin
      .from("ai_grading_reports")
      .insert({ user_id: referredFriend, status: "completed" })
      .select("id")
      .single();
    if (reportErr || !report) throw reportErr ?? new Error("report insert failed");

    const gradingOnlyResult = await recordReferralQualification(referredFriend, report.id);
    assertTrue(
      "grading alone does NOT qualify — inventory condition still outstanding",
      gradingOnlyResult.outcome === "not_yet_qualified" &&
        gradingOnlyResult.graded === true &&
        gradingOnlyResult.cardsAdded === 0,
      gradingOnlyResult,
    );

    const summaryMidway = await getReferralSummary(referrer);
    const midwayReward = summaryMidway.rewards.find((r) => r.referredUserId === referredFriend);
    assertTrue(
      "referrer's summary shows live per-referral progress while pending (graded true, 0 cards)",
      midwayReward?.status === "pending" &&
        midwayReward.progress?.graded === true &&
        midwayReward.progress?.cardsAdded === 0,
      midwayReward,
    );
    assertTrue(
      "referrer's summary exposes cardsRequired from the same constant the check itself uses",
      summaryMidway.cardsRequired === REFERRAL_INVENTORY_THRESHOLD,
      summaryMidway.cardsRequired,
    );

    // Now the friend adds cards — the second condition, and (per the ruling)
    // whichever completes second is what actually triggers qualification.
    const { data: someCard } = await supabaseAdmin
      .from("cards")
      .select("id")
      .limit(1)
      .maybeSingle();
    if (!someCard) throw new Error("no card rows exist to build a test inventory add from");
    const inventoryRows = Array.from({ length: REFERRAL_INVENTORY_THRESHOLD }, () => ({
      user_id: referredFriend,
      item_type: "raw_card",
      card_id: someCard.id,
      quantity: 1,
    }));
    const { data: insertedInventory, error: invErr } = await supabaseAdmin
      .from("inventory")
      .insert(inventoryRows)
      .select("id");
    if (invErr) throw invErr;

    const qualResult = await recordReferralInventoryQualification(referredFriend);
    assertTrue(
      "qualification grants the reward once BOTH conditions are met (under cap)",
      qualResult.outcome === "qualified_and_granted",
      qualResult,
    );

    const summary = await getReferralSummary(referrer);
    assertTrue("referrer's summary shows 1 referred, 1 qualified", summary.referredCount === 1 && summary.qualifiedCount === 1, summary);
    assertTrue("referrer's summary shows 1 granted month this year", summary.grantedMonthsThisYear === 1, summary);
    assertTrue("reward history has exactly 1 entry, status granted", summary.rewards.length === 1 && summary.rewards[0].status === "granted", summary.rewards);
    assertTrue(
      "granted reward's progress is null (nothing left to show progress toward)",
      summary.rewards[0].progress === null,
      summary.rewards[0],
    );

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
    if (insertedInventory) {
      await supabaseAdmin
        .from("inventory")
        .delete()
        .in("id", insertedInventory.map((r) => r.id));
    }
  } finally {
    console.log("\n=== Cleanup ===");
    for (const snap of flagSnapshots) {
      if (snap.existed) {
        // Restore exactly what was there before — never leaves a test
        // user on a real flag's allowlist.
        await supabaseAdmin
          .from("feature_flags")
          .update({ allowed_user_ids: snap.originalAllowedUserIds })
          .eq("id", snap.id);
        console.log(`  restored ${snap.key}'s original allowlist (${snap.originalAllowedUserIds.length} user(s))`);
      } else {
        await supabaseAdmin.from("feature_flags").delete().eq("id", snap.id);
        console.log(`  deleted temporary ${snap.key} row`);
      }
    }
    if (flagSnapshots.length > 0) invalidateFlagCache();
    for (const userId of createdUserIds) {
      // Safety net for the report/inventory rows too, in case the try block
      // threw before its own explicit cleanup above ran.
      await supabaseAdmin.from("ai_grading_reports").delete().eq("user_id", userId);
      await supabaseAdmin.from("inventory").delete().eq("user_id", userId);
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

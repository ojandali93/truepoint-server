// auditCompRowPlatformOverwrite.ts
//
// Blast-radius check for a bug pattern flagged in
// AUDITS/referral-program-plan.md Finding 2: any subscription-row writer
// that looks up an existing row by user_id ALONE (no platform filter) and
// then UPDATEs it in place can silently overwrite a REAL stripe/apple/
// google subscription row with comp/trial fields. Two writers had this
// shape: vendorCode.service.ts's redeemVendorCode, and
// adminPlatform.service.ts's updateUserPlan (the admin panel's manual
// plan-override, /admin/users/:id). Both fixed in this same branch
// (fix/comp-subscription-overwrite) to filter on platform='comp' before
// reusing a row, matching affiliateClaim.service.ts's grantCompPro's
// already-safe pattern.
//
// Fingerprint of an already-corrupted row: platform now reads 'comp', but
// it still carries a real-platform identifier neither writer's field list
// ever touches (stripe_customer_id, stripe_subscription_id, rc_app_user_id,
// provider_subscription_id) -- a normal comp row (grantCompPro, or either
// writer's own INSERT branch for a brand-new user) never populates those.
//
// Run 2026-09-02: redeemVendorCode has fired exactly once, ever, against a
// user with zero pre-existing rows -- that path has never actually
// corrupted anything. updateUserPlan has fired 14 times; 10 were safe
// inserts (no pre-existing row); the other 4 were a single, deliberate,
// documented "Phase 1 SS7 grandfather" migration batch (2026-08-29, all
// four calls one second apart) that intentionally converted 4 real Apple
// subscribers' existing rows into permanent comp grants "for policy
// uniformity" -- not accidental corruption, a deliberate decision executed
// through this code path. Those 4 users currently have working Pro access,
// exactly as that migration intended; NOT touched here -- reconciling them
// (e.g. backfilling comp_reason once the referral-program Finding 1
// migration lands) is a data decision for Omar, not a bug for this branch
// to silently fix. Flagged risk, not yet manifested: their stale
// rc_app_user_id/provider_subscription_id mean a future INITIAL_PURCHASE/
// RENEWAL/UNCANCELLATION/PRODUCT_CHANGE RC event for any of them (keyed by
// (user_id, platform) in upsertRevenueCatSubscription) would miss this row
// and insert a duplicate 'apple' row instead, rather than update it --
// CANCELLATION/EXPIRATION/BILLING_ISSUE events are keyed by
// provider_subscription_id directly and would still find it correctly
// (confirmed: one of the four already has a correct cancel_requested_at
// from exactly this path, set after the migration).
//
// Kept in the repo per this workspace's convention of keeping useful
// one-off audit scripts, not deleting them after use.
//
// Run: npx ts-node scripts/auditCompRowPlatformOverwrite.ts

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  console.log("=== Fingerprint check: platform='comp' rows carrying a real-platform identifier ===");
  const { data: suspects, error: sErr } = await supabaseAdmin
    .from("subscriptions")
    .select(
      "id, user_id, plan, status, platform, stripe_customer_id, stripe_subscription_id, rc_app_user_id, provider_subscription_id, trial_ends_at, current_period_end, created_at",
    )
    .eq("platform", "comp")
    .or(
      "stripe_customer_id.not.is.null,stripe_subscription_id.not.is.null,rc_app_user_id.not.is.null,provider_subscription_id.not.is.null",
    );
  if (sErr) throw sErr;
  console.log(`suspect rows: ${suspects?.length ?? 0}`);
  for (const r of suspects ?? []) console.log(JSON.stringify(r));

  console.log("\n=== vendor_code_redemptions: full list ===");
  const { data: redemptions, error: rErr } = await supabaseAdmin
    .from("vendor_code_redemptions")
    .select("id, code_id, user_id, redeemed_at")
    .order("redeemed_at", { ascending: true });
  if (rErr) throw rErr;
  console.log(`total redemptions: ${redemptions?.length ?? 0}`);
  for (const r of redemptions ?? []) console.log(JSON.stringify(r));

  console.log("\n=== For each redeemer: did they have ANY pre-existing subscription row (any platform) before their redemption? ===");
  for (const r of redemptions ?? []) {
    const { data: subs, error: subErr } = await supabaseAdmin
      .from("subscriptions")
      .select(
        "id, platform, plan, status, stripe_customer_id, provider_subscription_id, current_period_end, created_at",
      )
      .eq("user_id", r.user_id)
      .order("created_at", { ascending: true });
    if (subErr) throw subErr;
    const rows = subs ?? [];
    const preExisting = rows.filter(
      (s) => new Date(s.created_at).getTime() < new Date(r.redeemed_at).getTime(),
    );
    const hadRealPreExisting = preExisting.some((s) => s.platform !== "comp");
    console.log(
      JSON.stringify({
        user_id: r.user_id,
        redeemed_at: r.redeemed_at,
        total_subscription_rows_now: rows.length,
        pre_existing_rows_at_redemption_time: preExisting.length,
        had_real_platform_row_before_redeeming: hadRealPreExisting,
        all_rows: rows.map((s) => ({
          platform: s.platform,
          plan: s.plan,
          status: s.status,
          current_period_end: s.current_period_end,
          created_at: s.created_at,
          has_stripe_id: !!s.stripe_customer_id,
          has_provider_id: !!s.provider_subscription_id,
        })),
      }),
    );
  }

  console.log("\n=== error_logs mentioning vendor code / redemption ===");
  const { data: logs, error: lErr } = await supabaseAdmin
    .from("error_logs")
    .select("id, source, message, created_at")
    .or("source.ilike.%vendor%,message.ilike.%vendor code%,message.ilike.%redeem%")
    .order("created_at", { ascending: true })
    .limit(50);
  if (lErr) throw lErr;
  console.log(`count: ${logs?.length ?? 0}`);
  for (const l of logs ?? []) console.log(JSON.stringify(l));
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

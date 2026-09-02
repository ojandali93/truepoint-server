// verifyPhase2CommissionAdminSurface.ts
//
// Phase 2 gate (AUDITS/affiliate-system-plan.md §8): "a real affiliate row
// shows a correct ledger and lets 'mark paid' complete and reflect
// immediately." Doc's own gate text explicitly allows "one of the 3
// existing [affiliates], or a fresh test one" — this uses a fresh one,
// created and torn down by this script, so no real affiliate or customer
// account is touched. The affiliate row and its referred "user" are both
// 100% real rows written to the live database via the same service/
// repository functions the real admin surface calls — not a mock.
//
// Calls the SERVICE layer directly (getAffiliateCommissionSummary,
// markAffiliatePaid — the exact functions affiliateCommissionAdmin.
// controller.ts's routes call), not raw HTTP, so this verifies the real
// business logic against the live DB without needing to mint an admin JWT
// from a script. The HTTP/route/middleware wiring itself is unchanged from
// every other already-proven admin route in affiliate.admin.routes.ts
// (same authenticateUser+requireAdmin gate, same controller pattern).
//
// Cleans up everything it creates at the end, success or failure.
//
// Run: npx ts-node scripts/verifyPhase2CommissionAdminSurface.ts

import "dotenv/config";
import { supabaseAdmin } from "../src/lib/supabase";
import {
  getAffiliateCommissionSummary,
  markAffiliatePaid,
} from "../src/services/affiliateCommissionAdmin.service";

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
  const stamp = Date.now();
  let userId: string | null = null;
  let affiliateId: string | null = null;

  try {
    console.log("=== Creating a throwaway auth user (real profiles row via the signup trigger) ===");
    const { data: authUser, error: authErr } = await supabaseAdmin.auth.admin.createUser({
      email: `phase2-verify+${stamp}@reverseholo.io`,
      password: `verify-${stamp}-${Math.random().toString(36).slice(2)}`,
      email_confirm: true,
    });
    if (authErr || !authUser?.user) throw authErr ?? new Error("createUser returned no user");
    userId = authUser.user.id;
    console.log(`  user: ${userId}`);

    console.log("\n=== Creating a real affiliate row ===");
    const { data: affiliate, error: affErr } = await supabaseAdmin
      .from("affiliates")
      .insert({
        name: `Phase 2 Verification ${stamp}`,
        slug: `phase2-verify-${stamp}`,
        type: "vendor",
        active: true,
        commission_rate: 0.2,
        commission_window_months: 12,
      })
      .select("id")
      .single();
    if (affErr || !affiliate) throw affErr ?? new Error("affiliate insert returned nothing");
    affiliateId = affiliate.id;
    const affId: string = affiliate.id; // narrowed, non-null — used below instead of the outer nullable tracker
    console.log(`  affiliate: ${affId}`);

    console.log("\n=== Attributing the throwaway user to it, converted (window set) ===");
    const now = new Date();
    const windowEnd = new Date(now);
    windowEnd.setUTCMonth(windowEnd.getUTCMonth() + 12);
    const { data: attribution, error: attrErr } = await supabaseAdmin
      .from("referral_attributions")
      .insert({
        user_id: userId,
        affiliate_id: affiliateId,
        raw_code_entered: `phase2-verify-${stamp}`,
        resolved: true,
        source: "web_cookie",
        window_start: now.toISOString(),
        window_end: windowEnd.toISOString(),
      })
      .select("id")
      .single();
    if (attrErr || !attribution) throw attrErr ?? new Error("attribution insert returned nothing");
    console.log(`  attribution: ${attribution.id}`);

    console.log("\n=== Writing one real earning row and one real clawback row ===");
    const { data: earningRow, error: earnErr } = await supabaseAdmin
      .from("commission_ledger")
      .insert({
        affiliate_id: affiliateId,
        referred_user_id: userId,
        attribution_id: attribution.id,
        source_platform: "stripe",
        payment_event_id: `verify_earning_${stamp}`,
        payment_event_type: "invoice.payment_succeeded",
        gross: 14.99,
        fees: 0.73,
        net: 14.26,
        currency: "usd",
        rate_applied: 0.2,
        commission_amount: 2.85,
        is_clawback: false,
        clawback_of: null,
        earned_at: now.toISOString(),
        payout_period: now.toISOString().slice(0, 7),
        status: "eligible",
      })
      .select("*")
      .single();
    if (earnErr || !earningRow) throw earnErr ?? new Error("earning row insert returned nothing");

    const { data: clawbackRow, error: clawErr } = await supabaseAdmin
      .from("commission_ledger")
      .insert({
        affiliate_id: affiliateId,
        referred_user_id: userId,
        attribution_id: attribution.id,
        source_platform: "stripe",
        payment_event_id: `verify_clawback_${stamp}`,
        payment_event_type: "charge.refunded",
        gross: -5.0,
        fees: 0,
        net: -5.0,
        currency: "usd",
        rate_applied: 0.2,
        commission_amount: -1.0,
        is_clawback: true,
        clawback_of: earningRow.id,
        earned_at: now.toISOString(),
        payout_period: now.toISOString().slice(0, 7),
        status: "eligible",
      })
      .select("*")
      .single();
    if (clawErr || !clawbackRow) throw clawErr ?? new Error("clawback row insert returned nothing");
    console.log(`  earning: ${earningRow.id} (+$2.85), clawback: ${clawbackRow.id} (-$1.00, clawback_of earning)`);

    // ── Gate check 1: the ledger renders correctly, clawback as its own row ──
    console.log("\n=== getAffiliateCommissionSummary — before mark-paid ===");
    const before = await getAffiliateCommissionSummary(affId);
    assertTrue("ledger has exactly 2 rows (earning + clawback, no netting)", before.ledger.length === 2, before.ledger.length);
    assertTrue("the clawback row is present as its own row with is_clawback=true", before.ledger.some((r) => r.id === clawbackRow.id && r.is_clawback === true));
    assertTrue("the clawback row links back to the earning row via clawback_of", before.ledger.find((r) => r.id === clawbackRow.id)?.clawback_of === earningRow.id);
    assertTrue("referred user shows converted=true (window_start set)", before.referredUsers.find((u) => u.user_id === userId)?.converted === true);
    assertTrue("conversions.referred=1, conversions.converted=1", before.conversions.referred === 1 && before.conversions.converted === 1, before.conversions);
    assertTrue("attributedNetRevenue = 14.26 + (-5.00) = 9.26", before.totals.attributedNetRevenue === 9.26, before.totals);
    assertTrue("commissionEarned = 2.85 + (-1.00) = 1.85", before.totals.commissionEarned === 1.85, before.totals);
    assertTrue("commissionPending = 1.85 (both rows still eligible)", before.totals.commissionPending === 1.85, before.totals);
    assertTrue("commissionPaid = 0 (nothing paid yet)", before.totals.commissionPaid === 0, before.totals);
    assertTrue("payouts is empty before mark-paid", before.payouts.length === 0, before.payouts.length);

    // ── Gate check 2: mark-paid reflects immediately ──
    console.log("\n=== markAffiliatePaid ===");
    const markResult = await markAffiliatePaid(affId, {
      amount: 1.85,
      method: "PayPal",
      note: "Phase 2 live verification — safe to ignore",
      markedBy: null,
    });
    assertTrue("markAffiliatePaid covered exactly 2 ledger rows", markResult.ledgerRowsCovered === 2, markResult);
    assertTrue("eligibleTotalAtTimeOfPayout matched the pending total", markResult.eligibleTotalAtTimeOfPayout === 1.85, markResult);

    console.log("\n=== getAffiliateCommissionSummary — immediately after mark-paid ===");
    const after = await getAffiliateCommissionSummary(affId);
    assertTrue("commissionPending is now 0", after.totals.commissionPending === 0, after.totals);
    assertTrue("commissionPaid now reflects the payout", after.totals.commissionPaid === 1.85, after.totals);
    assertTrue("both ledger rows now show status='paid'", after.ledger.every((r) => r.status === "paid"), after.ledger.map((r) => r.status));
    assertTrue("both ledger rows carry the payout_id back-link", after.ledger.every((r) => r.payout_id === markResult.payout.id), after.ledger.map((r) => r.payout_id));
    assertTrue("payouts now has exactly 1 entry", after.payouts.length === 1, after.payouts.length);
    assertTrue("the payout amount/method match what was recorded", after.payouts[0]?.amount === 1.85 && after.payouts[0]?.method === "PayPal");

    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  } finally {
    console.log("\n=== Cleanup ===");
    if (affiliateId) {
      await supabaseAdmin.from("commission_ledger").delete().eq("affiliate_id", affiliateId);
      await supabaseAdmin.from("commission_payouts").delete().eq("affiliate_id", affiliateId);
      await supabaseAdmin.from("referral_attributions").delete().eq("affiliate_id", affiliateId);
      await supabaseAdmin.from("affiliates").delete().eq("id", affiliateId);
      console.log(`  deleted affiliate ${affiliateId} and its ledger/attribution/payout rows`);
    }
    if (userId) {
      await supabaseAdmin.auth.admin.deleteUser(userId);
      console.log(`  deleted throwaway auth user ${userId} (cascades to profiles)`);
    }
  }

  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

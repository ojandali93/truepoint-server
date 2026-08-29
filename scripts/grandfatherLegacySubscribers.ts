// One-off: grandfather the real active subscribers onto Pro at the moment
// of the §7 pricing migration (UX_OVERHAUL_PLAN.md, Phase 1 gate 7).
//
// Count corrected 2026-08-29: the plan doc's "2 real active subscribers"
// was stale planning-time memory. Omar's own live query of `subscriptions`
// returned FIVE active/trialing rows at grandfathering time — table wins
// over doc. Of those five, ONE (ca47801f-661e-44c6-9d15-342a3c15d400) is
// deliberately EXCLUDED here: a Stripe trial stuck at status='trialing'
// with current_period_end 2026-08-16, thirteen days past at the time this
// was found — a stale lifecycle row, not a real still-trialing subscriber.
// Root cause identified and BACKLOG'd (see BACKLOG.md, "Stripe webhook
// signature verification broken since 2026-06-29") — not fixed here, and
// deliberately not grandfathered while its true status is unknown.
//
// Mechanism: a separate platform='comp' row layered on top of each user's
// existing real subscription, via the same updateUserPlan() function the
// admin panel already uses for comp grants — NOT an in-place edit of their
// real row. That distinction matters: RevenueCat's RENEWAL webhook
// re-derives `plan` from the product id on every renewal and would silently
// revert an in-place edit at the subscriber's next billing cycle (verified
// by reading revenuecat.service.ts's INITIAL_PURCHASE/RENEWAL case before
// choosing this mechanism — Stripe's webhook path doesn't have this problem,
// but using one mechanism for both keeps this simple to reason about rather
// than having two different techniques per platform). A separate comp row
// is immune to both webhook paths — neither one ever touches or matches a
// platform='comp' row (no provider id to match against).
//
// Indefinite grant (durationMonths: null/undefined) — NOT a fixed-duration
// comp trial. Deactivation is instead tied to the real subscription's own
// lifecycle: deactivateGrandfatherCompIfNoRealSubRemains() (called from
// revenuecat.service.ts's EXPIRATION case and billing.service.ts's
// customer.subscription.deleted case) cancels this comp row automatically
// the moment the underlying real subscription actually lapses. Per Omar's
// ruling: "grandfathering rewards CONTINUING subscribers at their old
// price; it is not a permanent free grant that survives cancellation."
//
// User IDs verified by Omar directly from a live query of `subscriptions`
// (2026-08-29) — NOT derived or guessed here, per this repo's own
// verify-don't-assume discipline (CLAUDE.md §6's pricecharting_pricing
// flag lesson is the canonical example of why).
//
// Run once: npx ts-node scripts/grandfatherLegacySubscribers.ts
// Idempotent: updateUserPlan() upserts by (user_id, platform) — safe to
// re-run if it fails partway through.
//
// RESOLVED 2026-08-29: an earlier version of this file held [uuid1]/[uuid2]
// placeholders (Omar's own message named them exactly that way) and
// refused to run — see the guard below, kept as a standing safeguard, not
// just for that one incident.

import "dotenv/config";
import { updateUserPlan } from "../src/services/adminPlatform.service";

const SUBSCRIBERS: { userId: string; note: string }[] = [
  {
    userId: "2bee0d3f-b179-4bad-b58b-1f7d38e0789e",
    note: "Phase 1 §7 grandfather — paying subscriber (apple, plan already pro) at migration time; comp grant applied anyway for policy uniformity across all four",
  },
  {
    userId: "a912179a-0701-44b5-aa7d-c758758a3fa8",
    note: "Phase 1 §7 grandfather — trialing subscriber (apple, collector, trial ends 2026-08-31) at migration time",
  },
  {
    userId: "e30c28bf-af1c-487b-8b62-ac963259b1cf",
    note: "Phase 1 §7 grandfather — trialing subscriber (apple, collector, trial ends 2026-09-03) at migration time",
  },
  {
    userId: "c857df72-8e3d-4cfa-b512-366c77fddcdc",
    note: "Phase 1 §7 grandfather — trialing subscriber (apple, collector, trial ends 2026-09-05) at migration time",
  },
];

async function main() {
  const unfilled = SUBSCRIBERS.filter((s) => s.userId.startsWith("["));
  if (unfilled.length > 0) {
    console.error(
      `Refusing to run: ${unfilled.length} placeholder user id(s) still ` +
        `in SUBSCRIBERS (${unfilled.map((s) => s.userId).join(", ")}). ` +
        `Replace with the real UUIDs before running.`,
    );
    process.exit(1);
  }

  for (const { userId, note } of SUBSCRIBERS) {
    console.log(`Granting comp Pro to ${userId}...`);
    await updateUserPlan(userId, "pro", note, null);
    console.log(`  done.`);
  }
  console.log(
    "\nAll grants applied. Verify with a live read: select user_id, plan, status, platform from subscriptions where platform = 'comp' and user_id in (" +
      SUBSCRIBERS.map((s) => `'${s.userId}'`).join(", ") +
      ");",
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });

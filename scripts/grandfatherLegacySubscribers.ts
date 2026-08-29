// One-off: grandfather the 2 real active subscribers onto Pro at the moment
// of the §7 pricing migration (UX_OVERHAUL_PLAN.md, Phase 1 gate 7).
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
// User IDs verified by Omar directly from the admin panel (2026-08-29) —
// NOT derived or guessed here, per this repo's own verify-don't-assume
// discipline (CLAUDE.md §6's pricecharting_pricing flag lesson is the
// canonical example of why).
//
// Run once: npx ts-node scripts/grandfatherLegacySubscribers.ts
// Idempotent: updateUserPlan() upserts by (user_id, platform) — safe to
// re-run if it fails partway through.
//
// BLOCKED as written: [uuid1]/[uuid2] below are placeholders, not the real
// IDs — Omar's message named them exactly that way (matching the same
// bracket-placeholder pattern the gate 6 Stripe price IDs used), so this
// script deliberately refuses to run until they're filled in for real (see
// the guard right after this array) rather than silently no-op'ing or,
// worse, erroring confusingly mid-way through a partial run.

import "dotenv/config";
import { updateUserPlan } from "../src/services/adminPlatform.service";

const SUBSCRIBERS: { userId: string; note: string }[] = [
  {
    userId: "[uuid1]",
    note: "Phase 1 §7 grandfather — paying subscriber at migration time",
  },
  {
    userId: "[uuid2]",
    note: "Phase 1 §7 grandfather — trialing subscriber at migration time",
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

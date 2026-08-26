// src/constants/featureFlagKeys.ts
//
// Single source of truth for feature flag keys.
//
// The problem this solves: every useFlag()/requireFlag() call site has to
// use the EXACT same string as the key typed into the admin UI when the
// flag was created — "regrade_tracker" everywhere, not "regrade-tracker" in
// one place and "regradeTracker" in another. Nothing enforces that match;
// a typo in either direction just means the feature silently never shows up
// for anyone, with no error to point at. That's exactly what happened when
// this file didn't exist yet.
//
// Fix, in two parts:
//   1. Backend route/controller code imports FLAG_KEYS instead of typing the
//      string literal — so a typo here is a compile error, not a silent
//      runtime no-op.
//   2. KNOWN_FLAGS is served to the admin UI (GET /admin/flags/known-keys)
//      so "create a new flag" can suggest known keys instead of asking
//      someone to retype a string from memory.
//
// Mobile and web are separate codebases/repos, so their useFlag("...") call
// sites can't literally import this file — they still need the matching
// string typed by hand. Comment each call site with a pointer back here so
// the connection is at least documented, even where it can't be enforced.
//
// Adding a new flag-gated feature? Add it here FIRST, before writing any
// useFlag()/requireFlag() call — then every call site is copy-pasting a
// known-good value instead of retyping a string from memory.

export const FLAG_KEYS = {
  TESTER_CANARY: "tester_canary",
  REGRADE_TRACKER: "regrade_tracker",
  WATCHLIST: "watchlist",
  NOTIFY_DAILY_SUMMARY: "notify_daily_summary",
  NOTIFY_WATCHLIST_TRIGGERS: "notify_watchlist_triggers",
  NOTIFY_PRICE_MOVERS: "notify_price_movers",
  PRICECHARTING_PRICING: "pricecharting_pricing",
} as const;

export type FlagKeyName = (typeof FLAG_KEYS)[keyof typeof FLAG_KEYS];

export interface KnownFlag {
  key: string;
  label: string;
  description: string;
}

export const KNOWN_FLAGS: KnownFlag[] = [
  {
    key: FLAG_KEYS.TESTER_CANARY,
    label: "Tester Canary",
    description:
      "Pipeline smoke test. Gates a debug banner only — safe to toggle freely.",
  },
  {
    key: FLAG_KEYS.REGRADE_TRACKER,
    label: "Regrade Tracker",
    description:
      "Unowned graded arbitrage — price ladder, tracked list, and the " +
      '"Track for regrade" entry point on card detail. Mobile + web.',
  },
  {
    key: FLAG_KEYS.WATCHLIST,
    label: "Watchlist",
    description:
      "Track cards with optional buy-below / sell-above price triggers. " +
      "Trigger detection is live; push delivery isn't wired up yet.",
  },
  {
    key: FLAG_KEYS.NOTIFY_DAILY_SUMMARY,
    label: "Notify: Daily Summary",
    description:
      "Daily push with portfolio value and how it moved vs. yesterday and " +
      "last week. Per-user gated — allowlist testers before widening.",
  },
  {
    key: FLAG_KEYS.NOTIFY_WATCHLIST_TRIGGERS,
    label: "Notify: Watchlist Triggers",
    description:
      "Push when a watchlist item's buy or sell trigger newly crosses. " +
      "Per-user gated, checked at send time for every account individually.",
  },
  {
    key: FLAG_KEYS.NOTIFY_PRICE_MOVERS,
    label: "Notify: Price Movers",
    description:
      "Digest of notable price movement across owned inventory. Previously " +
      "disabled for not working correctly — keep this off longer than the " +
      "other two while that gets re-verified.",
  },
  {
    key: FLAG_KEYS.PRICECHARTING_PRICING,
    label: "PriceCharting Pricing (10-tier + Black Label)",
    description:
      "Cutover for CLAUDE.md §6's amended precedence contract: at the " +
      "grade-10 tier and BGS 10 Black Label, read PriceCharting only " +
      "(PokeTrace excluded entirely, no fallback — see fetchCardPrices / " +
      "getGradedPricesForCard). Off = today's behavior unchanged. " +
      "Off → allowlist (Omar) → everyone.",
  },
];

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
  PRO_PRICING_V2: "pro_pricing_v2",
  COUNTERFEIT_SCREENING: "counterfeit_screening",
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
  {
    key: FLAG_KEYS.PRO_PRICING_V2,
    label: "Pro Pricing v2 ($14.99/mo · $129.99/yr)",
    description:
      "UX_OVERHAUL_PLAN.md §7 Phase 1 gate 6 — new paywall display (Pro " +
      "monthly + annual, legacy Collector/Starter tiers retired from " +
      "DISPLAY only, never from the server's product mapping or anyone's " +
      "existing entitlement). MUST stay off until the ASC review for " +
      "pro_monthly_1499/pro_annual_12999 clears (status: Waiting for " +
      "Review as of this flag's creation — ships with the next app binary " +
      "submission). Flipping this on before that approves shows real " +
      "production users a Buy button for a product Apple hasn't approved " +
      "yet — the purchase will fail. Off → allowlist (Omar, sandbox-test " +
      "once ASC approves) → everyone.",
  },
  {
    key: FLAG_KEYS.COUNTERFEIT_SCREENING,
    label: "Counterfeit Screening",
    description:
      "AUDITS/counterfeit-screening-plan.md — Analyze tab sub-tab " +
      "visibility only; server-side entitlement/metering (free-tier, " +
      "5 screens/mo, unlimited Pro) is unconditional on this flag. Row " +
      "created + verified live 2026-09-01 (allowlist: Omar). Off → " +
      "allowlist → percentage → everyone — do not widen past allowlist " +
      "until the disclaimer/liability copy has real legal review " +
      "(flagged, unresolved as of this flag's creation).",
  },
];

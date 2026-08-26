// src/lib/gradedPricePrecedence.ts
//
// Single source of truth for the graded-pricing precedence contract
// (CLAUDE.md §6, LOCKED 2026-08-25, AMENDED 2026-08-25). Two call sites need
// this exact logic — inventory.repository.ts's fetchCardPrices (portfolio
// valuation) and poketracePriceSync.service.ts's getGradedPricesForCard
// (card-detail arbitrage/regrade ladder) — and having it duplicated in both
// is exactly how the original max()-across-sources bug happened. Don't
// duplicate this again; import it.
//
// Contract, in one sentence per tier:
//   Grades 1–9.5 → PokeTrace only, blank if missing.
//   Grade 10 tier (any company) + BGS 10 Black Label → PriceCharting only,
//   blank if missing. PokeTrace is NEVER read at 10+, even if PriceCharting
//   has nothing for that card — no fallback, one source per tier.
//
// market_prices.grade is written as "COMPANY VALUE" — "PSA 10", "BGS 9.5",
// "BGS 10 Black", "CGC 10 Pristine". Splitting on whitespace, the company is
// always parts[0]; the grade value is everything after (parts.slice(1)).

export interface ParsedGrade {
  company: string; // as-written, e.g. "PSA", "BGS" — NOT lowercased
  gradeValue: string; // everything after the company, e.g. "10", "9.5", "10 Black"
  flatKey: string; // `${company.toLowerCase()}_${gradeValue}` — the key shape
  //                   inventory.repository's cardPrices map and
  //                   resolveMarketValue's gradeKey both already use
}

/**
 * Parse a market_prices.grade string ("PSA 10", "BGS 10 Black", ...) into
 * its company + grade-value parts. Returns null for anything that doesn't
 * look like a graded row (no grade, or a single unsplittable token).
 */
export const parseGradeString = (raw: string | null | undefined): ParsedGrade | null => {
  if (!raw) return null;
  const parts = String(raw).trim().split(/\s+/);
  if (parts.length < 2) return null;
  const company = parts[0];
  const gradeValue = parts.slice(1).join(" ");
  return {
    company,
    gradeValue,
    flatKey: `${company.toLowerCase()}_${gradeValue}`,
  };
};

/**
 * True for the grade-10-tier and its super-tiers: "10", "10 Black" (BGS
 * Black Label), "10 Pristine" (CGC Pristine). False for everything below —
 * "9.5", "9", ... "1".
 */
export const isTenPlusGrade = (gradeValue: string): boolean =>
  gradeValue === "10" || gradeValue.startsWith("10 ");

/**
 * The one place that decides whether a given market_prices row is allowed
 * to be read, under the LOCKED contract. Sub-10: poketrace only (PC's
 * blended fields are dead — never read regardless of whether a row exists).
 * 10+: pricecharting only (poketrace excluded entirely, no fallback).
 *
 * Any other source value (e.g. 'poketrace_meta', 'estimated' once that
 * exists) is excluded at both tiers by this function — callers should only
 * ever pass real price rows here, but this keeps the boundary strict either
 * way rather than accidentally admitting a meta/marker row as a price.
 */
export const sourceAllowedAtTier = (source: string, gradeValue: string): boolean =>
  isTenPlusGrade(gradeValue) ? source === "pricecharting" : source === "poketrace";

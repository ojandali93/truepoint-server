// src/types/csvImport.types.ts
//
// Shared types for the Collectr → ReverseHolo CSV import pipeline
// (docs/csv-import-design.md). Phase 2 only: parse + match, zero writes.

export type ImportGame = "pokemon" | "onepiece";

// ─── Parse stage ────────────────────────────────────────────────────────────

export interface ParsedImportRow {
  rowIndex: number; // 1-based, excludes header — matches the line a user would count in a spreadsheet
  portfolioName: string;
  category: "Pokemon" | "One Piece";
  game: ImportGame;
  set: string; // raw Collectr set label, unmodified
  productName: string; // raw, including any (JP) suffix / parenthetical qualifiers
  cardNumber: string; // "" if empty
  rarity: string; // "" if empty
  variance: string;
  grade: string; // raw grade string, or "Ungraded"
  cardCondition: string;
  averageCostPaid: number | null;
  quantity: number;
  marketPriceCollectr: number | null; // parsed for row validity only — never stored or shown as ours (§1f)
  priceOverride: string;
  watchlist: string;
  dateAdded: string;
  notes: string;
  // Derived, computed once at parse time so match logic doesn't re-derive them per candidate check
  isJp: boolean;
  productNameStripped: string; // productName with a trailing "(JP)" removed, else same as productName
  isSealedSignature: boolean; // empty Card Number AND empty Rarity — see design doc §1d
}

export interface ImportParseError {
  rowIndex: number; // 1-based line number of the offending row (0 = header)
  message: string;
  raw: string; // the raw CSV line, for the user to see what failed
}

export interface ParseCsvResult {
  rows: ParsedImportRow[];
  errors: ImportParseError[];
}

// ─── Match stage ────────────────────────────────────────────────────────────

export type Confidence = "exact" | "high" | "needs-review" | "unmatched";

// Ordered worst → best is NOT the order here; keep best → worst for readability,
// worstOf() in csvImportMatch.ts is what actually combines multiple signals.
export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 3,
  high: 2,
  "needs-review": 1,
  unmatched: 0,
};

// Distinguishes *why* a row landed below exact, so callers (the harness now,
// Phase 3's commit endpoint later) can treat reasons differently — e.g. an
// unpriced-grade-tier row is needs-review but explicitly never blocking
// (Omar's Phase 1 decision #1), while ambiguous-candidates IS blocking.
export type ReasonCode =
  | "ok" // no issue — exact/high with a clean reason
  | "ambiguous-set" // 2+ live set candidates, no override resolves it
  | "unmatched-set" // 0 live set candidates
  | "unmatched-number" // set resolved, card number not found in it
  | "ambiguous-candidates" // set+number resolved to 2+ cards/products, qualifier text didn't pick one
  | "qualifier-tiebreak" // set+number resolved to 2+ candidates, exact qualifier text picked exactly one
  | "unmatched-product" // sealed: 0 product candidates in the resolved set
  | "ambiguous-product" // sealed: 2+ product candidates, normalized name didn't pick one
  | "unpriced-grade-tier" // grade parses to a real company+value but not a tier our locked contract prices (e.g. BGS 10 Pristine) — Phase 1 decision #1: import with true grade string, never coerced, never blocked
  | "unparseable-grade" // Grade column didn't match the expected "COMPANY N.N qualifier" / "Ungraded" shape at all
  | "variance-unmatched"; // Variance/qualifier didn't match any known card_variants row for the matched card

export interface MatchCandidate {
  cardId?: string;
  productId?: string;
  setId: string;
  setName: string;
  name: string;
  number?: string;
}

export type ItemType = "raw_card" | "graded_card" | "sealed_product";

export interface MatchResult {
  rowIndex: number;
  itemType: ItemType;
  confidence: Confidence;
  reasonCode: ReasonCode;
  reason: string; // human-readable detail for the harness / review UI

  matchedSetId?: string;
  matchedSetName?: string;
  matchedCardId?: string;
  matchedProductId?: string;
  matchedNumber?: string;
  matchedName?: string;

  // Target shapes for Phase 3's commit endpoint — computed here so Phase 3
  // never has to re-derive parsing/matching logic, only write the row.
  resolvedGrade?: string | null; // market_prices-style "COMPANY VALUE", or the true (possibly unpriced) grade string for unpriced-grade-tier rows, or null if ungraded
  resolvedGradingCompany?: string | null;
  resolvedVariantType?: string | null;
  resolvedIsSealed?: boolean;

  candidates?: MatchCandidate[]; // populated whenever confidence < exact and there's more than one thing to choose from
}

export interface MatchRowsResult {
  results: MatchResult[];
  summary: Record<Confidence, number>;
}

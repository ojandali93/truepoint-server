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

// Category gate (Omar's requirement A): a row whose Category isn't
// Pokemon/One Piece is never an error and never imported — it's excluded
// at parse time, counted, and carried through to the persistent
// not-imported record (see NotImportedRow below) with enough identifying
// text for "add this one manually" to mean something, even though it was
// never matched against any catalog.
export interface UnsupportedCategoryRow {
  rowIndex: number;
  category: string; // whatever the CSV actually said — not narrowed to the supported union
  portfolioName: string;
  set: string;
  productName: string;
  cardNumber: string;
}

export interface ParseCsvResult {
  rows: ParsedImportRow[];
  errors: ImportParseError[];
  unsupportedCategoryRows: UnsupportedCategoryRow[];
  categoryCounts: Record<string, number>; // every Category value seen, supported or not
  unsupportedCategorySummary: string | null; // e.g. "3 items in unsupported categories — ReverseHolo tracks Pokémon and One Piece today"; null when there are none
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
  imageUrl?: string | null; // Phase 4: mobile review screen renders candidate cards with art
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
  matchedImageUrl?: string | null; // Phase 4: mobile review/summary screens render card art

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

// ─── Commit stage (Phase 3) ─────────────────────────────────────────────────

export type NotImportedReason = "unmatched" | "skipped" | "unsupported-category";

// One shape for all three reasons a row didn't land in inventory —
// deliberately (Omar's requirement B): the review UI shows one list
// ("we couldn't confirm or import these — add them manually"), not three.
export interface NotImportedRow {
  rowIndex: number;
  reason: NotImportedReason;
  portfolioName: string;
  category: string;
  set: string;
  productName: string;
  cardNumber: string;
}

// What the client sends for one row it wants written to inventory — either
// a match the matcher already resolved at exact/high, or a needs-review
// row the user tapped to confirm a specific candidate. Either way the
// commit endpoint trusts THIS payload's target ids, not the confidence
// bucket — re-matching at commit time would let the catalog drift between
// match and commit; the client is the one source of truth for "the user
// confirmed row N means card/product X."
export interface ConfirmedImportItem {
  rowIndex: number;
  itemType: ItemType;
  cardId?: string;
  productId?: string;
  grade?: string | null;
  gradingCompany?: string | null;
  variantType?: string | null;
  isSealed?: boolean;
  quantity: number;
  purchasePrice?: number | null;
  condition?: string | null;
}

export interface CommitImportRequest {
  idempotencyKey: string;
  totalRows: number;
  items: ConfirmedImportItem[];
  notImported: NotImportedRow[];
}

export interface CommitImportResult {
  importJobId: string;
  imported: number;
  notImportedCount: number;
  portfolioValue: number | null; // ReverseHolo's own valuation of the imported items, summed — never Collectr's Market Price column (§1f)
  notImported: NotImportedRow[];
  replayed: boolean; // true when this idempotencyKey already had a job — nothing was written this call
}

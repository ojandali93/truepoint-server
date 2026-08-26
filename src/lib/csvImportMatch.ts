// src/lib/csvImportMatch.ts
//
// The matching pipeline itself (docs/csv-import-design.md §1a/§1b). Pure
// functions over a prebuilt CatalogIndex — no I/O here; csvImport.service.ts
// fetches the catalog data and calls into this module per row. Kept pure
// deliberately so the validation harness (scripts/validateCsvImportMatch.ts)
// can call the exact same code the /import/match endpoint calls, not a
// re-implementation of it.
//
// Confidence is uniqueness-gated throughout: every resolution step counts
// its candidates and only ever promotes to exact/high when exactly one
// survives. This isn't a stylistic choice — Phase 1 design verified real
// cases where the SAME set+number resolves to 1 candidate for one card
// (OP05-007) and 6 for another (ST15-005, same promo set) — a fixed
// "number is enough" or "number is never enough" rule would be wrong in
// one direction or the other on real data.

import { variantKey } from "./variantKey";
import {
  CatalogCard,
  CatalogProduct,
  CatalogVariant,
  LiveSet,
} from "../repositories/csvImportCatalog.repository";
import {
  CONFIDENCE_RANK,
  Confidence,
  ImportGame,
  MatchCandidate,
  MatchResult,
  ParsedImportRow,
  ReasonCode,
} from "../types/csvImport.types";

export interface CatalogIndex {
  setsByGame: Record<ImportGame, LiveSet[]>;
  cardsBySetId: Map<string, CatalogCard[]>;
  productsBySetId: Map<string, CatalogProduct[]>;
  variantsByCardId: Map<string, CatalogVariant[]>;
}

// ─── Small string helpers ───────────────────────────────────────────────────

const normalizeLoose = (s: string): string =>
  s.trim().replace(/\s+/g, " ").toLowerCase();

// variantKey() strips anything outside [a-z0-9], which silently drops
// accented characters instead of folding them ("Poké Ball" -> "poball", not
// "pokeball") — found while designing variance matching. Not a variantKey.ts
// bug worth touching (shared utility, used by live pricing paths); folded
// locally instead so both sides of a variance comparison get the same
// treatment.
const foldAccents = (s: string): string =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");

const normalizeVarianceText = (s: string): string => variantKey(foldAccents(s));

const worstOf = (...cs: Confidence[]): Confidence =>
  cs.reduce((worst, c) => (CONFIDENCE_RANK[c] < CONFIDENCE_RANK[worst] ? c : worst));

/** Strip one leading "<code>: " or "<code> - " token, if present. */
const stripLeadingCode = (name: string): string | null => {
  const colon = name.match(/^\S+:\s+(.+)$/);
  if (colon) return colon[1].trim();
  const dash = name.match(/^\S+\s-\s+(.+)$/);
  if (dash) return dash[1].trim();
  return null;
};

/** Trailing "(Unlimited)" / "(1st Edition)" on a SET label — a Collectr
 * print-status suffix on vintage WOTC sets, not a distinct catalog set
 * (verified: our catalog has one "Base Set", print status lives on
 * card_variants, same pattern as Jungle Pikachu's 1stedition/unlimited
 * variant rows). */
const SET_LABEL_PRINT_STATUS_RE = /\s*\((Unlimited|1st Edition)\)\s*$/i;

// Manual overrides (docs/csv-import-design.md §1a), each verified against
// live data by resolving a real fixture row's number to a unique card
// before adding the entry here — none of these are guesses:
//
//   "sun & moon base set" -> "SM Base Set": not a prefix relationship at
//     all ("Sun & Moon" is spelled out, catalog uses the bare "SM"
//     abbreviation) — verified via Hypno #60 -> card_id 126931 in set 1863.
//   "scarlet & violet promo" -> "SV: Scarlet & Violet Promo Cards": missing
//     trailing "Cards" — verified via Charizard ex #056, unique hit.
//   "sword & shield promo" -> "SWSH: Sword & Shield Promo Cards": same
//     "Cards" gap, PLUS verified this is the right one of two candidates —
//     "SWSH086" also exists on an unrelated "Jumbo Cards" set; the promo
//     numbering (SWSH###) only lines up with Sword & Shield Promo Cards.
//   "pokemon 151" -> "SV2a: Pokemon Card 151": this fixture's only "Pokemon
//     151" row is the JP-tagged Hitmonlee — this target is itself Japanese,
//     so it only ever fires for a JP row post-language-filter (see
//     resolveSet's language narrowing above); an English "Pokemon 151" row
//     would still correctly fall through unmatched.
//   "sv: 151" -> "SV: Scarlet & Violet 151": Omar's Phase 2 decision — the
//     "SV: 151" ambiguity IS an EN/JP pair ("SV2a: Pokemon Card 151" is
//     Japanese, this target is English) and routes English per that
//     decision. This override is keyed on the literal label "sv: 151", so
//     it only ever fires for a row whose Set column says that; a
//     hypothetical JP-tagged row under that same label would get its
//     candidates narrowed to Japanese-only first, this (English) target
//     wouldn't survive that filter, and the row would correctly fall
//     through to unmatched rather than silently landing on either language
//     — no fixture row exercises this path, so it's untested, not assumed.
const SET_ALIAS_OVERRIDES: Partial<Record<ImportGame, Record<string, string>>> = {
  pokemon: {
    "mega evolution promos": "ME: Mega Evolution Promo",
    "sun & moon base set": "SM Base Set",
    "scarlet & violet promo": "SV: Scarlet & Violet Promo Cards",
    "sword & shield promo": "SWSH: Sword & Shield Promo Cards",
    "pokemon 151": "SV2a: Pokemon Card 151",
    "sv: 151": "SV: Scarlet & Violet 151",
  },
};

// ─── Set resolution ──────────────────────────────────────────────────────────

interface SetResolution {
  confidence: Confidence;
  reasonCode: ReasonCode;
  matched?: LiveSet;
  candidates: LiveSet[];
  impliedVariantHint?: "unlimited" | "1stedition";
}

export const resolveSet = (
  rawSetLabel: string,
  game: ImportGame,
  liveSetsAllLanguages: LiveSet[],
  isJp: boolean,
): SetResolution => {
  // Language routing BEFORE name matching, not after — verified live: a
  // Collectr set label like "Black Bolt" resolves to TWO live catalog rows
  // that look like an ambiguous duplicate ("SV: Black Bolt" / "SV11B: Black
  // Bolt") until you notice one is English and the other Japanese. Same
  // shape hit "White Flare" and "Gym Challenge" — none of them are actual
  // catalog duplicates; they're EN/JP pairs this function was resolving
  // without ever looking at language. Narrowing first turns each of those
  // into a single, unambiguous candidate.
  //
  // Asymmetric fallback, deliberately: a non-JP-tagged row ("Inferno X",
  // "Mega Symphonia" — verified live, each has exactly ONE catalog set and
  // it's Japanese-only, no English edition exists at all) falls back to
  // searching all languages when the English-first search comes up empty,
  // because there's no English alternative it could be silently confused
  // with. A JP-tagged row does NOT get that fallback — "Trading Card Game
  // Classic (Japanese)" has no Japanese catalog edition (verified: only the
  // English "Trading Card Game Classic" exists), and falling back there
  // would silently match a Japanese-tagged row to an English print, which
  // is simply wrong, not just low-confidence. That row stays unmatched.
  const languageFiltered = liveSetsAllLanguages.filter((s) =>
    isJp ? s.language === "Japanese" : s.language !== "Japanese",
  );

  const printStatusMatch = rawSetLabel.match(SET_LABEL_PRINT_STATUS_RE);
  const impliedVariantHint = printStatusMatch
    ? ((printStatusMatch[1].toLowerCase() === "unlimited"
        ? "unlimited"
        : "1stedition") as "unlimited" | "1stedition")
    : undefined;
  const label = printStatusMatch
    ? rawSetLabel.replace(SET_LABEL_PRINT_STATUS_RE, "").trim()
    : rawSetLabel.trim();
  const target = normalizeLoose(label);

  // The actual name-matching cascade, run against whichever pool of live
  // sets the caller hands it — a plain function of (pool, target), not a
  // closure trick, so the fallback below can genuinely re-run it rather
  // than duplicate its logic.
  const resolveAgainstPool = (pool: LiveSet[]): SetResolution => {
    const exact = pool.filter((s) => normalizeLoose(s.name) === target);
    if (exact.length === 1) {
      return { confidence: "exact", reasonCode: "ok", matched: exact[0], candidates: exact, impliedVariantHint };
    }
    if (exact.length > 1) {
      return { confidence: "needs-review", reasonCode: "ambiguous-set", candidates: exact, impliedVariantHint };
    }

    const stripped = pool.filter((s) => {
      const strippedName = stripLeadingCode(s.name);
      return strippedName != null && normalizeLoose(strippedName) === target;
    });
    if (stripped.length === 1) {
      return { confidence: "exact", reasonCode: "ok", matched: stripped[0], candidates: stripped, impliedVariantHint };
    }
    if (stripped.length > 1) {
      return { confidence: "needs-review", reasonCode: "ambiguous-set", candidates: stripped, impliedVariantHint };
    }

    const overrideTarget = SET_ALIAS_OVERRIDES[game]?.[target];
    if (overrideTarget) {
      const overrideMatch = pool.filter((s) => normalizeLoose(s.name) === normalizeLoose(overrideTarget));
      if (overrideMatch.length === 1) {
        return { confidence: "high", reasonCode: "ok", matched: overrideMatch[0], candidates: overrideMatch, impliedVariantHint };
      }
    }

    return { confidence: "unmatched", reasonCode: "unmatched-set", candidates: [], impliedVariantHint };
  };

  const primary = resolveAgainstPool(languageFiltered);
  // Asymmetric fallback, deliberately: only retry unrestricted when the
  // PRIMARY (language-scoped) search found genuinely nothing AND the row
  // wasn't JP-tagged. Never fires for isJp rows — a JP-tagged row with no
  // Japanese catalog match (verified: "Trading Card Game Classic
  // (Japanese)" has no Japanese edition, only English) stays unmatched
  // rather than silently landing on the wrong-language print.
  if (primary.confidence === "unmatched" && !isJp) {
    return resolveAgainstPool(liveSetsAllLanguages);
  }
  return primary;
};

// ─── Grade parsing ──────────────────────────────────────────────────────────

const KNOWN_COMPANIES = new Set(["PSA", "BGS", "CGC", "SGC", "TAG", "ACE"]);

// Locked per pricechartingClient.ts's TEN_TIER_FIELDS (not exported there,
// mirrored here — see that file's field-map comment block for the source
// of truth; keep in sync if the contract changes).
const LOCKED_BARE_TEN = new Set(["PSA", "BGS", "CGC", "SGC", "TAG", "ACE"]);
const CGC_PRISTINE_LOCKED = true; // "CGC 10 Pristine" — condition-19-price
const BGS_BLACK_LOCKED = true; // "BGS 10 Black" — condition-20-price

export interface GradeParseResult {
  isGraded: boolean;
  targetGrade: string | null; // final string for market_prices.grade, or the true (possibly unpriced) string
  gradingCompany: string | null;
  confidence: Confidence; // this signal's own contribution — combined via worstOf() by the caller
  reasonCode: ReasonCode;
  detail: string;
}

const GEM_MINT_DEFAULT_RE = /^(gem[\s-]*mint|gem\s*-?\s*mt|mint\+?|nm[\s-]*mt\+?)?$/i;

export const parseGradeColumn = (raw: string): GradeParseResult => {
  const trimmed = raw.trim();
  if (trimmed.toLowerCase() === "ungraded" || trimmed === "") {
    return {
      isGraded: false,
      targetGrade: null,
      gradingCompany: null,
      confidence: "exact",
      reasonCode: "ok",
      detail: "ungraded",
    };
  }

  const parts = trimmed.split(/\s+/);
  const company = parts[0]?.toUpperCase();
  const numeric = parts[1];
  if (parts.length < 2 || !company || !KNOWN_COMPANIES.has(company) || !numeric || !/^\d+(\.\d+)?$/.test(numeric)) {
    return {
      isGraded: true,
      targetGrade: null,
      gradingCompany: company && KNOWN_COMPANIES.has(company) ? company : null,
      confidence: "needs-review",
      reasonCode: "unparseable-grade",
      detail: `Grade column "${raw}" didn't match "<COMPANY> <N.N> [qualifier]"`,
    };
  }

  const numericVal = parseFloat(numeric);
  const numericTrimmed = numeric.replace(/\.0$/, "");
  const qualifier = parts.slice(2).join(" ").trim();
  const qLower = qualifier.toLowerCase();

  if (numericVal < 10) {
    // Sub-10: company-specific numeric only, qualifier text is a condition
    // label Collectr adds ("NM-MT", "Mint+") that our schema has no slot
    // for at this tier — discarded, verified against every sub-10 value in
    // the fixture (docs/csv-import-design.md §1a).
    return {
      isGraded: true,
      targetGrade: `${company} ${numericTrimmed}`,
      gradingCompany: company,
      confidence: "exact",
      reasonCode: "ok",
      detail: "sub-10, qualifier discarded by contract",
    };
  }

  // 10-tier: qualifier decides which locked tier, if any.
  if (qLower.includes("pristine")) {
    if (company === "CGC" && CGC_PRISTINE_LOCKED) {
      return {
        isGraded: true,
        targetGrade: `${company} 10 Pristine`,
        gradingCompany: company,
        confidence: "exact",
        reasonCode: "ok",
        detail: "CGC 10 Pristine — locked tier",
      };
    }
    // Not a priced tier under the locked contract (verified for BGS —
    // pricechartingClient.ts has no "BGS 10 Pristine" field; treated the
    // same for any other company since none of them have a Pristine field
    // either). Omar's Phase 1 decision #1: import with the TRUE grade
    // string, needs-review for confirmation, never coerced, never blocked.
    return {
      isGraded: true,
      targetGrade: `${company} 10 Pristine`,
      gradingCompany: company,
      confidence: "needs-review",
      reasonCode: "unpriced-grade-tier",
      detail: `${company} 10 Pristine has no priced tier in the locked contract — imported as-is, blank until priced`,
    };
  }

  if (qLower.includes("black")) {
    if (company === "BGS" && BGS_BLACK_LOCKED) {
      return {
        isGraded: true,
        targetGrade: `${company} 10 Black`,
        gradingCompany: company,
        confidence: "exact",
        reasonCode: "ok",
        detail: "BGS 10 Black (Black Label) — locked tier",
      };
    }
    return {
      isGraded: true,
      targetGrade: `${company} 10 Black`,
      gradingCompany: company,
      confidence: "needs-review",
      reasonCode: "unpriced-grade-tier",
      detail: `${company} 10 Black has no priced tier in the locked contract — imported as-is, blank until priced`,
    };
  }

  if (GEM_MINT_DEFAULT_RE.test(qualifier) && LOCKED_BARE_TEN.has(company)) {
    return {
      isGraded: true,
      targetGrade: `${company} 10`,
      gradingCompany: company,
      confidence: "exact",
      reasonCode: "ok",
      detail: `bare ${company} 10 — locked tier, qualifier "${qualifier}" is this company's default-10 label`,
    };
  }

  // A 10-tier qualifier we don't recognize at all — don't guess.
  return {
    isGraded: true,
    targetGrade: null,
    gradingCompany: company,
    confidence: "needs-review",
    reasonCode: "unparseable-grade",
    detail: `Unrecognized 10-tier qualifier "${qualifier}" for ${company}`,
  };
};

// ─── Variance / qualifier resolution ────────────────────────────────────────

const TRAILING_PAREN_RE = /\(([^)]+)\)\s*$/;

interface VarianceResolution {
  variantType: string | null;
  confidence: Confidence;
  reasonCode: ReasonCode;
  detail: string;
}

export const resolveVariance = (
  row: ParsedImportRow,
  cardVariants: CatalogVariant[],
): VarianceResolution => {
  if (cardVariants.length === 0) {
    // No card_variants rows synced for this card at all — a known,
    // partial-coverage gap independent of this import (set_variant_status
    // tracks pending/ready per set). Not this row's fault; don't downgrade
    // confidence for a catalog gap the user can't act on from the review
    // screen. Same graceful-degradation posture as variantMatch.ts's
    // existing "representative fallback."
    return {
      variantType: null,
      confidence: "exact",
      reasonCode: "ok",
      detail: "no card_variants rows synced for this card — variant unconfirmed, not disputed",
    };
  }

  const varianceTarget = normalizeVarianceText(row.variance);
  const byVariance = cardVariants.find(
    (v) => normalizeVarianceText(v.label) === varianceTarget || normalizeVarianceText(v.variantType) === varianceTarget,
  );
  if (byVariance) {
    return {
      variantType: byVariance.variantType,
      confidence: "exact",
      reasonCode: "ok",
      detail: `Variance "${row.variance}" matched card_variants label "${byVariance.label}"`,
    };
  }

  // Fall back to a trailing parenthetical qualifier on the product name —
  // Collectr's only slot for finish/print-pattern tags that aren't in the
  // Variance column at all (e.g. "(Poke Ball Pattern)"). §1b class (1).
  const paren = row.productNameStripped.match(TRAILING_PAREN_RE)?.[1];
  if (paren) {
    const parenTarget = normalizeVarianceText(paren);
    const byParen = cardVariants.find(
      (v) => normalizeVarianceText(v.label) === parenTarget || normalizeVarianceText(v.variantType) === parenTarget,
    );
    if (byParen) {
      return {
        variantType: byParen.variantType,
        confidence: "exact",
        reasonCode: "ok",
        detail: `Name qualifier "(${paren})" matched card_variants label "${byParen.label}"`,
      };
    }
  }

  return {
    variantType: null,
    confidence: "needs-review",
    reasonCode: "variance-unmatched",
    detail: `Variance "${row.variance}" didn't match any of this card's ${cardVariants.length} known variant(s)`,
  };
};

// ─── Number matching ─────────────────────────────────────────────────────────

const numberMatches = (catalogNumber: string, rawNumber: string): boolean => {
  const a = catalogNumber.trim().toLowerCase();
  const b = rawNumber.trim().toLowerCase();
  if (a === b) return true;
  // Vintage bare numbers ("60") vs catalog "N/total" ("60/64").
  const prefix = a.split("/")[0];
  if (prefix === b) return true;
  // Zero-padding differs (verified: catalog stores vintage numbers padded,
  // "002/102" for Base Set Blastoise; Collectr exports bare "2") — compare
  // numerically once both sides are confirmed to be plain digit strings, so
  // this never accidentally matches something like "10" against "010a".
  if (/^\d+$/.test(prefix) && /^\d+$/.test(b)) {
    return parseInt(prefix, 10) === parseInt(b, 10);
  }
  return false;
};

// ─── Row matching ────────────────────────────────────────────────────────────

const toCandidate = (
  setId: string,
  setName: string,
  c: CatalogCard | CatalogProduct,
): MatchCandidate => ({
  cardId: "number" in c ? c.id : undefined,
  productId: "productType" in c ? c.id : undefined,
  setId,
  setName,
  name: c.name,
  number: "number" in c ? c.number : undefined,
  imageUrl: "number" in c ? c.imageSmall : c.imageUrl,
});

export const matchRow = (row: ParsedImportRow, index: CatalogIndex): MatchResult => {
  const liveSets = index.setsByGame[row.game] ?? [];
  const setRes = resolveSet(row.set, row.game, liveSets, row.isJp);

  if (!setRes.matched) {
    return {
      rowIndex: row.rowIndex,
      itemType: row.isSealedSignature ? "sealed_product" : row.grade.trim().toLowerCase() === "ungraded" ? "raw_card" : "graded_card",
      confidence: setRes.confidence,
      reasonCode: setRes.reasonCode,
      reason:
        setRes.reasonCode === "ambiguous-set"
          ? `Set "${row.set}" matches ${setRes.candidates.length} live sets — no deterministic tiebreaker`
          : `Set "${row.set}" doesn't match any live set for game=${row.game}`,
      candidates: setRes.candidates.map((s) => ({
        setId: s.id,
        setName: s.name,
        name: s.name,
      })),
    };
  }

  const set = setRes.matched;

  // ── Sealed products ──
  if (row.isSealedSignature) {
    const products = index.productsBySetId.get(set.id) ?? [];
    const target = normalizeLoose(row.productNameStripped);
    const candidates = products.filter((p) => normalizeLoose(p.name) === target);

    if (candidates.length === 1) {
      const confidence = worstOf(setRes.confidence, "exact");
      return {
        rowIndex: row.rowIndex,
        itemType: "sealed_product",
        confidence,
        reasonCode: "ok",
        reason: `Sealed product matched "${candidates[0].name}" in ${set.name}`,
        matchedSetId: set.id,
        matchedSetName: set.name,
        matchedProductId: candidates[0].id,
        matchedName: candidates[0].name,
        matchedImageUrl: candidates[0].imageUrl,
        resolvedIsSealed: true,
      };
    }
    const reasonCode: ReasonCode = candidates.length === 0 ? "unmatched-product" : "ambiguous-product";
    return {
      rowIndex: row.rowIndex,
      itemType: "sealed_product",
      confidence: candidates.length === 0 ? "unmatched" : "needs-review",
      reasonCode,
      reason:
        candidates.length === 0
          ? `No product named "${row.productNameStripped}" found in ${set.name} (${products.length} products in set)`
          : `${candidates.length} products named "${row.productNameStripped}" in ${set.name}`,
      matchedSetId: set.id,
      matchedSetName: set.name,
      resolvedIsSealed: true,
      candidates: (candidates.length ? candidates : products).map((p) => toCandidate(set.id, set.name, p)),
    };
  }

  // ── Cards (raw or graded) ──
  const cards = index.cardsBySetId.get(set.id) ?? [];
  const isGraded = row.grade.trim().toLowerCase() !== "ungraded";
  const itemType = isGraded ? "graded_card" : "raw_card";

  let numberCandidates: CatalogCard[];
  if (row.cardNumber !== "") {
    numberCandidates = cards.filter((c) => numberMatches(c.number, row.cardNumber));
  } else {
    // Numberless, non-sealed (e.g. DON!! cards — verified: Rarity populated,
    // Card Number empty, distinct from the sealed signature). Name is the
    // only key available.
    const target = normalizeLoose(row.productNameStripped);
    numberCandidates = cards.filter((c) => normalizeLoose(c.name) === target);
  }

  if (numberCandidates.length === 0) {
    return {
      rowIndex: row.rowIndex,
      itemType,
      confidence: "unmatched",
      reasonCode: "unmatched-number",
      reason:
        row.cardNumber !== ""
          ? `No card numbered "${row.cardNumber}" found in ${set.name}`
          : `No card named "${row.productNameStripped}" found in ${set.name} (numberless row)`,
      matchedSetId: set.id,
      matchedSetName: set.name,
    };
  }

  let matchedCard: CatalogCard;
  let itemConfidence: Confidence;
  let itemReasonCode: ReasonCode;
  let itemDetail: string;

  if (numberCandidates.length === 1) {
    matchedCard = numberCandidates[0];
    itemConfidence = "exact";
    itemReasonCode = "ok";
    itemDetail = `Unique match on ${row.cardNumber !== "" ? `number "${row.cardNumber}"` : "name"} in ${set.name}`;
  } else {
    // 2+ candidates share the number (verified real case: OP promo
    // reprints — same number, different promo-batch qualifier) or share the
    // exact name (numberless). Full raw-name text, including parentheticals,
    // is the only remaining tiebreaker.
    const target = normalizeLoose(row.productNameStripped);
    const exactName = numberCandidates.filter((c) => normalizeLoose(c.name) === target);
    if (exactName.length === 1) {
      matchedCard = exactName[0];
      itemConfidence = "high";
      itemReasonCode = "qualifier-tiebreak";
      itemDetail = `${numberCandidates.length} candidates shared the number; exact name text "${row.productNameStripped}" picked one`;
    } else {
      return {
        rowIndex: row.rowIndex,
        itemType,
        confidence: "needs-review",
        reasonCode: "ambiguous-candidates",
        reason: `${numberCandidates.length} cards match${row.cardNumber !== "" ? ` number "${row.cardNumber}"` : " this name"} in ${set.name}; qualifier text didn't pick exactly one`,
        matchedSetId: set.id,
        matchedSetName: set.name,
        candidates: numberCandidates.map((c) => toCandidate(set.id, set.name, c)),
      };
    }
  }

  const variance = resolveVariance(row, index.variantsByCardId.get(matchedCard.id) ?? []);
  const grade = isGraded
    ? parseGradeColumn(row.grade)
    : { isGraded: false, targetGrade: null, gradingCompany: null, confidence: "exact" as Confidence, reasonCode: "ok" as ReasonCode, detail: "raw card" };

  // Confidence is the worst of the three independent signals (set was
  // already folded in via setRes.confidence above). reasonCode/reason
  // follow whichever signal is actually the worst one, so a needs-review
  // row always names the real cause (an unpriced grade tier vs. an
  // unmatched variance vs. a qualifier tiebreak) rather than a generic label.
  const signals: Array<{ confidence: Confidence; reasonCode: ReasonCode; detail: string }> = [
    { confidence: itemConfidence, reasonCode: itemReasonCode, detail: itemDetail },
    { confidence: grade.confidence, reasonCode: grade.reasonCode, detail: grade.detail },
    { confidence: variance.confidence, reasonCode: variance.reasonCode, detail: variance.detail },
  ];
  const confidence = worstOf(setRes.confidence, ...signals.map((s) => s.confidence));
  const worstSignal = signals.reduce((worst, s) =>
    CONFIDENCE_RANK[s.confidence] < CONFIDENCE_RANK[worst.confidence] ? s : worst,
  );
  const reasonCode: ReasonCode = worstSignal.reasonCode;
  const reasonParts = [itemDetail, ...signals.slice(1).filter((s) => s.reasonCode !== "ok").map((s) => s.detail)];

  return {
    rowIndex: row.rowIndex,
    itemType,
    confidence,
    reasonCode,
    reason: reasonParts.join("; "),
    matchedSetId: set.id,
    matchedSetName: set.name,
    matchedCardId: matchedCard.id,
    matchedNumber: matchedCard.number,
    matchedName: matchedCard.name,
    matchedImageUrl: matchedCard.imageSmall,
    resolvedGrade: grade.targetGrade,
    resolvedGradingCompany: grade.gradingCompany,
    resolvedVariantType: variance.variantType,
    resolvedIsSealed: false,
    candidates: numberCandidates.length > 1 ? numberCandidates.map((c) => toCandidate(set.id, set.name, c)) : undefined,
  };
};

// src/lib/csvImportParse.ts
//
// Column-contract parsing for a Collectr collection export (docs/
// csv-import-design.md §1a). Pure, synchronous, zero I/O — no catalog
// lookups here, that's csvImportMatch.ts. This stage only turns raw CSV
// text into typed rows and rejects rows that don't even parse as CSV,
// never mind whether they match anything.
//
// No CSV library exists in this repo's dependencies — the fixture does use
// real RFC4180 quoting (verified: `"1,055.48"` for the comma-thousands
// price fields), so a naive comma-split would corrupt those rows. The
// parser below is a small, deliberately-conservative RFC4180 implementation
// (quoted fields, embedded commas, doubled "" escapes, CR/LF-agnostic) —
// not a general-purpose library, just enough for this fixed 16-column shape.

import {
  ImportGame,
  ImportParseError,
  ParseCsvResult,
  ParsedImportRow,
  UnsupportedCategoryRow,
} from "../types/csvImport.types";

export const EXPECTED_HEADERS = [
  "Portfolio Name",
  "Category",
  "Set",
  "Product Name",
  "Card Number",
  "Rarity",
  "Variance",
  "Grade",
  "Card Condition",
  "Average Cost Paid",
  "Quantity",
  // The 12th header carries a live date, e.g. "Market Price (As of 2026-08-26)"
  // — matched by prefix below (validateHeader special-cases index 11), not
  // this exact string. Kept here only so EXPECTED_HEADERS.length is correct.
  "Market Price (As of ...)",
  "Price Override",
  "Watchlist",
  "Date Added",
  "Notes",
] as const;

const MARKET_PRICE_HEADER_PREFIX = "Market Price";

// ─── RFC4180-ish line splitter ──────────────────────────────────────────────

/**
 * Splits raw CSV text into records (arrays of field strings), honoring
 * quoted fields (which may contain commas, and "" as an escaped quote) and
 * quoted fields that span multiple physical lines. Trailing blank line is
 * dropped. CRLF and bare LF both accepted.
 */
export const splitCsvRecords = (text: string): string[][] => {
  // Strip a UTF-8 BOM if present (Collectr's export, and Excel exports
  // generally, are BOM-prefixed).
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;
  const n = src.length;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < n) {
    const c = src[i];

    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ",") {
      endField();
      i += 1;
      continue;
    }
    if (c === "\r") {
      // Only treat as a line break if followed by \n or end-of-input;
      // otherwise it's a stray CR inside an unquoted field — keep it.
      if (src[i + 1] === "\n") {
        endRecord();
        i += 2;
        continue;
      }
      endRecord();
      i += 1;
      continue;
    }
    if (c === "\n") {
      endRecord();
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }

  // Flush a trailing field/record if the file didn't end with a newline.
  if (field.length > 0 || record.length > 0) {
    endRecord();
  }

  // Drop a fully-empty trailing record (common when the file does end with
  // a newline — splitting produces one final [""] record).
  while (
    records.length > 0 &&
    records[records.length - 1].length === 1 &&
    records[records.length - 1][0] === ""
  ) {
    records.pop();
  }

  return records;
};

// ─── Field parsing helpers ──────────────────────────────────────────────────

/** "1,055.48" → 1055.48. Empty/unparseable → null, never NaN or 0. */
const parseMoney = (raw: string): number | null => {
  const stripped = raw.trim().replace(/,/g, "");
  if (stripped === "") return null;
  const n = Number(stripped);
  return Number.isFinite(n) ? n : null;
};

const parseQuantity = (raw: string): number => {
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
};

const GAME_BY_CATEGORY: Record<string, ImportGame> = {
  Pokemon: "pokemon",
  "One Piece": "onepiece",
};

const JP_SUFFIX_RE = /\s*\(JP\)\s*$/;

// ─── Duplicate-row merge ─────────────────────────────────────────────────────
//
// Collectr exports one row PER PHYSICAL COPY for raw/graded cards — owning 2
// of the same card produces two otherwise-identical rows, quantity=1 each,
// rather than one row with quantity=2. Left alone, that meant a card the
// user owned multiples of needed the review screen's needs-review confirm
// tapped once per duplicate row instead of once total, and committed as N
// separate inventory rows instead of one row with quantity N (Omar,
// 2026-09-03 — observed on a real test import).
//
// A "duplicate" here is conservative and literal: every field that
// determines what gets matched/written must be identical — portfolio, set,
// exact product name (JP suffix included, so an EN and a JP printing of the
// same card never merge), card number, rarity, variance, grade, and
// condition. Rows differing in any of those are genuinely different items
// (different grade, different condition, etc.) and are never merged, even
// if they're "the same card" in a looser sense. Only quantity (summed) and
// average cost paid (quantity-weighted average across the merged rows,
// nulls excluded — an unknown cost on one copy shouldn't drag the known
// cost on another toward zero) change; every other field keeps the first
// occurrence's value, and that first occurrence's rowIndex is what survives
// — later duplicates' line numbers aren't individually reachable after
// this, which is the point of merging them.
const dedupeKey = (row: ParsedImportRow): string =>
  [
    row.portfolioName,
    row.category,
    row.set,
    row.productName,
    row.cardNumber,
    row.rarity,
    row.variance,
    row.grade,
    row.cardCondition,
  ].join("");

const mergeDuplicateRows = (rows: ParsedImportRow[]): ParsedImportRow[] => {
  const order: string[] = [];
  const grouped = new Map<string, ParsedImportRow[]>();
  for (const row of rows) {
    const key = dedupeKey(row);
    if (!grouped.has(key)) {
      order.push(key);
      grouped.set(key, []);
    }
    grouped.get(key)!.push(row);
  }

  return order.map((key) => {
    const group = grouped.get(key)!;
    if (group.length === 1) return group[0];

    const totalQuantity = group.reduce((sum, r) => sum + r.quantity, 0);
    const pricedGroup = group.filter((r) => r.averageCostPaid != null);
    const pricedQuantity = pricedGroup.reduce((sum, r) => sum + r.quantity, 0);
    const averageCostPaid =
      pricedGroup.length === 0
        ? null
        : pricedGroup.reduce((sum, r) => sum + r.averageCostPaid! * r.quantity, 0) / pricedQuantity;

    return { ...group[0], quantity: totalQuantity, averageCostPaid };
  });
};

// ─── Public entry point ─────────────────────────────────────────────────────

export const parseCollectrCsv = (text: string): ParseCsvResult => {
  const records = splitCsvRecords(text);
  const errors: ImportParseError[] = [];

  if (records.length === 0) {
    errors.push({ rowIndex: 0, message: "Empty file", raw: "" });
    return {
      rows: [],
      errors,
      unsupportedCategoryRows: [],
      categoryCounts: {},
      unsupportedCategorySummary: null,
    };
  }

  const header = records[0];
  const headerErrors = validateHeader(header);
  if (headerErrors.length > 0) {
    errors.push({
      rowIndex: 0,
      message: `Unexpected header shape: ${headerErrors.join("; ")}`,
      raw: header.join(","),
    });
    // Header mismatch doesn't necessarily mean every row is unusable, but
    // column positions are no longer trustworthy — stop rather than guess.
    return {
      rows: [],
      errors,
      unsupportedCategoryRows: [],
      categoryCounts: {},
      unsupportedCategorySummary: null,
    };
  }

  const rows: ParsedImportRow[] = [];
  const unsupportedCategoryRows: UnsupportedCategoryRow[] = [];
  const categoryCounts: Record<string, number> = {};

  for (let r = 1; r < records.length; r += 1) {
    const rec = records[r];
    const rowIndex = r; // 1-based, matches the data row number (header excluded)
    const raw = rec.join(",");

    if (rec.length !== EXPECTED_HEADERS.length) {
      errors.push({
        rowIndex,
        message: `Expected ${EXPECTED_HEADERS.length} columns, found ${rec.length}`,
        raw,
      });
      continue;
    }

    const [
      portfolioName,
      categoryRaw,
      set,
      productName,
      cardNumber,
      rarity,
      variance,
      grade,
      cardCondition,
      averageCostPaidRaw,
      quantityRaw,
      marketPriceRaw,
      priceOverride,
      watchlist,
      dateAdded,
      notes,
    ] = rec;

    const category = categoryRaw.trim();
    categoryCounts[category] = (categoryCounts[category] ?? 0) + 1;

    const game = GAME_BY_CATEGORY[category];
    if (!game) {
      // Category gate (requirement A): NOT a parse error. Excluded, counted,
      // and reported — never imported, never blocks the rest of the file.
      unsupportedCategoryRows.push({
        rowIndex,
        category,
        portfolioName: portfolioName.trim(),
        set: set.trim(),
        productName: productName.trim(),
        cardNumber: cardNumber.trim(),
      });
      continue;
    }
    if (!set.trim() || !productName.trim()) {
      errors.push({
        rowIndex,
        message: "Missing required Set or Product Name",
        raw,
      });
      continue;
    }

    const trimmedCardNumber = cardNumber.trim();
    const trimmedRarity = rarity.trim();
    const productNameTrimmed = productName.trim();
    const isJp = JP_SUFFIX_RE.test(productNameTrimmed);
    const productNameStripped = isJp
      ? productNameTrimmed.replace(JP_SUFFIX_RE, "").trim()
      : productNameTrimmed;

    rows.push({
      rowIndex,
      portfolioName: portfolioName.trim(),
      category: category as "Pokemon" | "One Piece",
      game,
      set: set.trim(),
      productName: productNameTrimmed,
      cardNumber: trimmedCardNumber,
      rarity: trimmedRarity,
      variance: variance.trim(),
      grade: grade.trim(),
      cardCondition: cardCondition.trim(),
      averageCostPaid: parseMoney(averageCostPaidRaw),
      quantity: parseQuantity(quantityRaw),
      marketPriceCollectr: parseMoney(marketPriceRaw),
      priceOverride: priceOverride.trim(),
      watchlist: watchlist.trim(),
      dateAdded: dateAdded.trim(),
      notes: notes.trim(),
      isJp,
      productNameStripped,
      isSealedSignature: trimmedCardNumber === "" && trimmedRarity === "",
    });
  }

  const unsupportedCategorySummary =
    unsupportedCategoryRows.length > 0
      ? `${unsupportedCategoryRows.length} item${unsupportedCategoryRows.length === 1 ? "" : "s"} in unsupported categories — ReverseHolo tracks Pokémon and One Piece today`
      : null;

  return {
    rows: mergeDuplicateRows(rows),
    errors,
    unsupportedCategoryRows,
    categoryCounts,
    unsupportedCategorySummary,
  };
};

const validateHeader = (header: string[]): string[] => {
  const problems: string[] = [];
  if (header.length !== EXPECTED_HEADERS.length) {
    problems.push(
      `expected ${EXPECTED_HEADERS.length} columns, found ${header.length}`,
    );
  }
  EXPECTED_HEADERS.forEach((expected, idx) => {
    const actual = (header[idx] ?? "").trim();
    if (idx === 11) {
      // "Market Price (As of <date>)" — the date makes this column's exact
      // text a moving target; match by prefix only.
      if (!actual.startsWith(MARKET_PRICE_HEADER_PREFIX)) {
        problems.push(
          `column 12: expected to start with "${MARKET_PRICE_HEADER_PREFIX}", found "${actual}"`,
        );
      }
      return;
    }
    if (actual !== expected) {
      problems.push(`column ${idx + 1}: expected "${expected}", found "${actual}"`);
    }
  });
  return problems;
};

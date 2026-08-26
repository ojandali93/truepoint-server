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

// ─── Public entry point ─────────────────────────────────────────────────────

export const parseCollectrCsv = (text: string): ParseCsvResult => {
  const records = splitCsvRecords(text);
  const errors: ImportParseError[] = [];

  if (records.length === 0) {
    errors.push({ rowIndex: 0, message: "Empty file", raw: "" });
    return { rows: [], errors };
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
    return { rows: [], errors };
  }

  const rows: ParsedImportRow[] = [];

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
    const game = GAME_BY_CATEGORY[category];
    if (!game) {
      errors.push({
        rowIndex,
        message: `Unrecognized Category "${category}" — expected "Pokemon" or "One Piece"`,
        raw,
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

  return { rows, errors };
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

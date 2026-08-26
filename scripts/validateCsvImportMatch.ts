// scripts/validateCsvImportMatch.ts
//
// Phase 2 gate (docs/csv-import-design.md §1e): runs the real Collectr
// fixture (fixtures/export (1).csv, 522 rows) through the exact parse +
// match pipeline the /import/parse and /import/match endpoints use, then
// prints the match-rate table by confidence bucket, per-bucket row
// listings for needs-review/unmatched, and 10 randomly-sampled "exact"
// matches for hand-checking — per Omar's Phase 2 gate.
//
// Usage: npx ts-node scripts/validateCsvImportMatch.ts

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

import { parseImportCsv, matchImportRows } from "../src/services/csvImport.service";
import { MatchResult, ParsedImportRow } from "../src/types/csvImport.types";

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "export (1).csv");

const pct = (n: number, total: number): string =>
  total === 0 ? "0.0%" : `${((n / total) * 100).toFixed(1)}%`;

const main = async () => {
  const csvText = fs.readFileSync(FIXTURE_PATH, "utf-8");
  const { rows, errors: parseErrors } = parseImportCsv(csvText);

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" CSV IMPORT — PARSE");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Fixture: ${FIXTURE_PATH}`);
  console.log(`Parsed rows: ${rows.length}`);
  console.log(`Parse errors: ${parseErrors.length}`);
  if (parseErrors.length > 0) {
    for (const e of parseErrors) {
      console.log(`  row ${e.rowIndex}: ${e.message}`);
    }
  }

  const { results, summary } = await matchImportRows(rows);
  const total = results.length;

  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log(" CSV IMPORT — MATCH-RATE TABLE (by confidence)");
  console.log("═══════════════════════════════════════════════════════════");
  const order: Array<keyof typeof summary> = ["exact", "high", "needs-review", "unmatched"];
  const colWidth = 14;
  console.log(
    order.map((k) => k.padEnd(colWidth)).join("") + "total".padEnd(colWidth),
  );
  console.log(
    order.map((k) => String(summary[k]).padEnd(colWidth)).join("") +
      String(total).padEnd(colWidth),
  );
  console.log(
    order.map((k) => pct(summary[k], total).padEnd(colWidth)).join("") +
      "100.0%".padEnd(colWidth),
  );

  // Breakdown by reasonCode within needs-review and unmatched — this is
  // what actually tells you WHY, not just how many.
  const byReason = (bucket: "needs-review" | "unmatched") => {
    const rows = results.filter((r) => r.confidence === bucket);
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
    return { rows, counts };
  };

  const rowByIndex = new Map<number, ParsedImportRow>(rows.map((r) => [r.rowIndex, r]));

  const printBucket = (label: string, bucket: "needs-review" | "unmatched") => {
    const { rows: bucketRows, counts } = byReason(bucket);
    console.log();
    console.log("───────────────────────────────────────────────────────────");
    console.log(` ${label.toUpperCase()} — ${bucketRows.length} rows`);
    console.log("───────────────────────────────────────────────────────────");
    for (const [reason, count] of Array.from(counts.entries()).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason}: ${count}`);
    }
    console.log();
    for (const r of bucketRows) {
      const src = rowByIndex.get(r.rowIndex);
      const setLabel = src ? src.set : "?";
      const nameLabel = src ? src.productName : "?";
      const numLabel = src?.cardNumber || "(none)";
      const gradeLabel = src?.grade ?? "";
      console.log(
        `  row ${r.rowIndex}: [${r.reasonCode}] "${setLabel}" / "${nameLabel}" #${numLabel} — ${gradeLabel}`,
      );
      console.log(`           ${r.reason}`);
      if (r.candidates && r.candidates.length > 0) {
        for (const c of r.candidates.slice(0, 8)) {
          const idPart = c.cardId ? `card ${c.cardId}` : c.productId ? `product ${c.productId}` : "set";
          console.log(`             candidate: ${idPart} "${c.name}" #${c.number ?? ""} (${c.setName})`);
        }
        if (r.candidates.length > 8) {
          console.log(`             ...and ${r.candidates.length - 8} more`);
        }
      }
    }
  };

  printBucket("needs-review", "needs-review");
  printBucket("unmatched", "unmatched");

  // 10 randomly-sampled "exact" matches for hand-checking.
  const exactResults = results.filter((r) => r.confidence === "exact" && (r.matchedCardId || r.matchedProductId));
  const sampleSize = Math.min(10, exactResults.length);
  const sampled: MatchResult[] = [];
  const pool = [...exactResults];
  for (let i = 0; i < sampleSize; i += 1) {
    const idx = Math.floor(Math.random() * pool.length);
    sampled.push(pool[idx]);
    pool.splice(idx, 1);
  }

  console.log();
  console.log("───────────────────────────────────────────────────────────");
  console.log(` ${sampleSize} RANDOMLY-SAMPLED "EXACT" MATCHES — hand-check these`);
  console.log("───────────────────────────────────────────────────────────");
  for (const r of sampled) {
    const src = rowByIndex.get(r.rowIndex)!;
    console.log(`  row ${r.rowIndex}: "${src.set}" / "${src.productName}" #${src.cardNumber || "(none)"} — ${src.grade}`);
    console.log(
      `           -> ${r.itemType} | ${r.matchedCardId ? `card_id=${r.matchedCardId}` : `product_id=${r.matchedProductId}`} | set="${r.matchedSetName}" (${r.matchedSetId}) | number="${r.matchedNumber ?? ""}" | name="${r.matchedName}"`,
    );
    if (r.resolvedGrade) console.log(`           grade -> "${r.resolvedGrade}"`);
    if (r.resolvedVariantType) console.log(`           variant -> "${r.resolvedVariantType}"`);
  }

  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log(` DONE — ${total} rows matched, ${parseErrors.length} parse errors`);
  console.log("═══════════════════════════════════════════════════════════");
};

main().catch((err) => {
  console.error("[validateCsvImportMatch] failed:", err);
  process.exit(1);
});

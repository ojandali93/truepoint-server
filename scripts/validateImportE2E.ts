// scripts/validateImportE2E.ts
//
// Phase 3 gate (Omar): the full fixture, parse -> match -> commit, into a
// real (test) account. Prints per-bucket row counts, commits the
// exact/high rows, re-runs the exact same commit with the same
// idempotency key and proves nothing gets written twice, retrieves the
// persistent not-imported record back out as if the import session had
// ended, and shows the portfolio total.
//
// STANDING FIXTURE ACCOUNT (Omar's call, 2026-08-26): this is no longer a
// throwaway. csv-import-test+1787772816902@reverseholo.io,
// user_id 1ffd8815-bc62-49b8-af28-ce375030df08 — created for this gate,
// kept afterward on purpose as the import-regression fixture. A 490-item
// same-day CSV import is the best additions-bucket/hasAnyHistory edge case
// this codebase has had for portfolioMovers — see
// scripts/validateMovers.ts, run against this same user id, where the
// identity closing at $0.00 against a real (not synthetic) same-day-import
// portfolio is the actual value of keeping this account around. Live gate
// run 2026-08-26: 423 exact + 67 high = 490 imported, 32 not-imported (27
// needs-review + 5 unmatched), portfolio value $7,063.53, idempotency
// re-run confirmed zero additional writes. Don't delete this account or
// its inventory without updating this comment and validateMovers.ts's own
// notes on it.
//
// REQUIRES, before this will do anything but fail loudly:
//   1. migrations/2026-08-26_import_jobs.sql applied (Supabase SQL editor —
//      not applied automatically, see that file). Confirmed applied
//      2026-08-26.
//   2. A TEST_USER_ID — defaults to the standing fixture account above;
//      override via env var to point at a different (still TEST) account.
//      This script WRITES real inventory rows and a real import_jobs row
//      for whichever user id it runs against — never point it at a live
//      user's account.
//
// Usage: npx ts-node scripts/validateImportE2E.ts
//        TEST_USER_ID=<uuid> npx ts-node scripts/validateImportE2E.ts   # override

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";

import { parseImportCsv, matchImportRows, commitImport } from "../src/services/csvImport.service";
import { getImportJob } from "../src/repositories/importJobs.repository";
import { supabaseAdmin } from "../src/lib/supabase";
import {
  ConfirmedImportItem,
  MatchResult,
  NotImportedRow,
  ParsedImportRow,
} from "../src/types/csvImport.types";

const FIXTURE_PATH = path.join(__dirname, "..", "fixtures", "export (1).csv");
const IDEMPOTENCY_KEY = "phase3-gate-run-1";
const STANDING_FIXTURE_USER_ID = "1ffd8815-bc62-49b8-af28-ce375030df08";

const conditionFor = (raw: string): string | null => (raw === "Near Mint" ? "NM" : null);

const main = async () => {
  const testUserId = process.env.TEST_USER_ID || STANDING_FIXTURE_USER_ID;

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" PHASE 3 GATE — full fixture, parse -> match -> commit");
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`Test user: ${testUserId}`);

  const csvText = fs.readFileSync(FIXTURE_PATH, "utf-8");
  const parsed = parseImportCsv(csvText);
  console.log(`Parsed: ${parsed.rows.length} rows, ${parsed.errors.length} parse errors, ${parsed.unsupportedCategoryRows.length} unsupported-category rows`);
  if (parsed.unsupportedCategorySummary) console.log(`  ${parsed.unsupportedCategorySummary}`);

  const { results, summary } = await matchImportRows(parsed.rows);
  console.log();
  console.log("Match buckets:");
  console.log(`  exact: ${summary.exact}  high: ${summary.high}  needs-review: ${summary["needs-review"]}  unmatched: ${summary.unmatched}`);

  const rowByIndex = new Map<number, ParsedImportRow>(parsed.rows.map((r) => [r.rowIndex, r]));

  // Auto-import policy for this unattended gate run: exact + high only —
  // needs-review rows are NEVER auto-imported (they require a user tap in
  // the real review UI; there's no user here to tap, so they land in
  // notImported same as if the session ended without anyone resolving
  // them). This is the actual product rule, not a gate shortcut.
  const items: ConfirmedImportItem[] = [];
  const notImported: NotImportedRow[] = [];

  for (const r of results as MatchResult[]) {
    const src = rowByIndex.get(r.rowIndex)!;
    if (r.confidence === "exact" || r.confidence === "high") {
      items.push({
        rowIndex: r.rowIndex,
        itemType: r.itemType,
        cardId: r.matchedCardId,
        productId: r.matchedProductId,
        grade: r.resolvedGrade ?? null,
        gradingCompany: r.resolvedGradingCompany ?? null,
        variantType: r.resolvedVariantType ?? null,
        isSealed: r.resolvedIsSealed,
        quantity: src.quantity,
        purchasePrice: src.averageCostPaid,
        condition: conditionFor(src.cardCondition),
      });
    } else {
      notImported.push({
        rowIndex: r.rowIndex,
        reason: "unmatched",
        portfolioName: src.portfolioName,
        category: src.category,
        set: src.set,
        productName: src.productName,
        cardNumber: src.cardNumber,
      });
    }
  }
  for (const u of parsed.unsupportedCategoryRows) {
    notImported.push({
      rowIndex: u.rowIndex,
      reason: "unsupported-category",
      portfolioName: u.portfolioName,
      category: u.category,
      set: u.set,
      productName: u.productName,
      cardNumber: u.cardNumber,
    });
  }

  console.log();
  console.log(`Committing: ${items.length} items to import, ${notImported.length} not-imported rows`);

  const { count: beforeCount } = await supabaseAdmin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", testUserId);
  console.log(`Inventory row count before commit: ${beforeCount}`);

  const first = await commitImport(testUserId, "user", {
    idempotencyKey: IDEMPOTENCY_KEY,
    totalRows: parsed.rows.length + parsed.unsupportedCategoryRows.length,
    items,
    notImported,
  });

  const { count: afterFirstCount } = await supabaseAdmin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", testUserId);

  console.log();
  console.log("─── First commit ───");
  console.log(`  importJobId: ${first.importJobId}`);
  console.log(`  imported: ${first.imported}`);
  console.log(`  notImportedCount: ${first.notImportedCount}`);
  console.log(`  portfolioValue: ${first.portfolioValue}`);
  console.log(`  replayed: ${first.replayed}`);
  console.log(`  inventory row count after: ${afterFirstCount} (delta: ${(afterFirstCount ?? 0) - (beforeCount ?? 0)})`);

  // Idempotency re-run — SAME key, same payload. Should write nothing.
  const second = await commitImport(testUserId, "user", {
    idempotencyKey: IDEMPOTENCY_KEY,
    totalRows: parsed.rows.length + parsed.unsupportedCategoryRows.length,
    items,
    notImported,
  });

  const { count: afterSecondCount } = await supabaseAdmin
    .from("inventory")
    .select("id", { count: "exact", head: true })
    .eq("user_id", testUserId);

  console.log();
  console.log("─── Idempotency re-run (same idempotencyKey) ───");
  console.log(`  importJobId: ${second.importJobId} (same as first: ${second.importJobId === first.importJobId})`);
  console.log(`  replayed: ${second.replayed}`);
  console.log(`  inventory row count after: ${afterSecondCount} (delta vs first commit: ${(afterSecondCount ?? 0) - (afterFirstCount ?? 0)})`);
  console.log(
    afterSecondCount === afterFirstCount
      ? "  PASS — idempotency re-run imported NOTHING"
      : "  FAIL — re-run wrote additional rows",
  );

  // Persistent summary retrieval — simulates re-opening the app after the
  // import session ended: a fresh read of the job by id, not anything
  // cached from the commit call above.
  const retrieved = await getImportJob(testUserId, first.importJobId);
  console.log();
  console.log("─── Persistent record, retrieved fresh by job id ───");
  console.log(`  found: ${retrieved != null}`);
  console.log(`  notImported.length matches: ${retrieved?.notImported.length === first.notImportedCount}`);

  console.log();
  console.log("═══════════════════════════════════════════════════════════");
  console.log(` PORTFOLIO TOTAL (ReverseHolo valuation): $${first.portfolioValue?.toFixed(2) ?? "—"}`);
  console.log("═══════════════════════════════════════════════════════════");
};

main().catch((err) => {
  console.error("[validateImportE2E] failed:", err);
  process.exit(1);
});

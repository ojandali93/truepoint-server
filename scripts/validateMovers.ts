// scripts/validateMovers.ts
//
// Phase 2 validation harness for portfolio movers attribution
// (src/services/portfolioMovers.service.ts). Runs the real service — same
// code path as GET /portfolio/movers — for one userId across all three
// windows, and prints a full reconciliation table per window for hand
// verification against real data.
//
// Bypasses HTTP/auth entirely (calls the service directly with role:"admin"
// so requireFeature's plan gate never blocks — this is about validating the
// math for ANY account, not testing the paywall). Never mutates data; every
// query the service makes is a read.
//
// Usage:
//   npx ts-node scripts/validateMovers.ts <userId> [collectionId]
//
// Exit code 0 = every window's identity divergence was exactly $0.00.
// Exit code 1 = at least one window diverged, or the run errored — per the
// approved plan, ANY nonzero divergence here is a Phase 1 bug to fix, not a
// data-quality footnote.

import "dotenv/config";
import {
  getPortfolioMovers,
  MoversWindow,
  PortfolioMoversResult,
} from "../src/services/portfolioMovers.service";

const WINDOWS: MoversWindow[] = ["1d", "7d", "30d"];

const fmt = (n: number): string => {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
};
const pad = (s: string, n: number): string => (s.length >= n ? s : s + " ".repeat(n - s.length));

function printWindow(result: PortfolioMoversResult): boolean {
  console.log(
    `\n───────────────────────── window=${result.window} ─────────────────────────`,
  );
  console.log(`asOf:                   ${result.comparisonTimestamps.asOf}`);
  console.log(
    `requestedWindowStart:   ${result.comparisonTimestamps.requestedWindowStart}`,
  );
  console.log(
    `actualSnapshotDateUsed: ${result.comparisonTimestamps.actualSnapshotDateUsed ?? "(none resolved)"}`,
  );

  console.log(`\nTotals:`);
  console.log(`  currentValue:            ${fmt(result.totals.currentValue)}`);
  console.log(
    `  reconstructedStartValue: ${fmt(result.totals.reconstructedStartValue)}`,
  );
  console.log(
    `  delta:                   ${fmt(result.totals.delta)}` +
      (result.totals.deltaPct != null ? `  (${result.totals.deltaPct.toFixed(2)}%)` : ""),
  );

  console.log(
    `\nMarket movement (${result.marketMovement.movers.length} attributable holding(s), total ${fmt(result.marketMovement.total)}):`,
  );
  for (const m of result.marketMovement.movers) {
    const label =
      m.itemType === "graded_card"
        ? `${m.gradingCompany} ${m.grade}`
        : (m.variantType ?? "raw");
    console.log(
      `  ${m.contributionApproximate ? "~" : " "} ${pad(m.name, 28)} ${pad(label, 14)} ` +
        `qty=${m.quantity}  then=${fmt(m.priceThen)}  now=${fmt(m.priceNow)}  ` +
        `contrib=${fmt(m.contribution)}` +
        (m.contributionPct != null ? ` (${m.contributionPct.toFixed(1)}%)` : ""),
    );
  }

  console.log(
    `\nAdditions (${result.additions.entries.length}, total ${fmt(result.additions.total)}):`,
  );
  for (const a of result.additions.entries) {
    console.log(
      `    ${pad(a.name, 28)} qty=${a.quantity}  addedAt=${a.addedAt}  value=${fmt(a.currentValue)}`,
    );
  }

  console.log(
    `\nRemovals (${result.removals.entries.length}, market total ${fmt(result.removals.total)}, realized total ${fmt(result.removals.totalRealized)}):`,
  );
  for (const r of result.removals.entries) {
    console.log(
      `    ${pad(r.name, 28)} qty=${r.quantity}  soldAt=${r.soldAt}  ` +
        `marketValueUsed=${fmt(r.marketValueUsed)} (${r.marketValueSource})  ` +
        `soldPrice=${fmt(r.soldPrice)}  vsMarket=${fmt(r.vsMarket)}`,
    );
  }

  console.log(
    `\nExcluded (${result.excluded.count}, last-known total ${fmt(result.excluded.totalLastKnownValue)}):`,
  );
  for (const e of result.excluded.entries) {
    console.log(
      `    ${pad(e.name, 28)} reason=${pad(e.reason, 24)} lastKnownValue=${fmt(e.lastKnownValue)}`,
    );
  }

  console.log(
    `\nData quality: hasAnyHistory=${result.dataQuality.hasAnyHistory}  ` +
      `approximateCount=${result.dataQuality.approximateCount}  ` +
      `addedAndSoldCount=${result.dataQuality.addedAndSoldCount}`,
  );
  if (result.dataQuality.note) console.log(`  note: ${result.dataQuality.note}`);

  console.log(`\nIdentity:`);
  console.log(`  namedMoversTotal:   ${fmt(result.identity.namedMoversTotal)}`);
  console.log(`  other:              ${fmt(result.identity.other)}`);
  console.log(`  inventoryDelta:     ${fmt(result.identity.inventoryDelta)}`);
  console.log(
    `  computedTotalDelta: ${fmt(result.identity.computedTotalDelta)}   <- namedMovers + other + inventoryDelta`,
  );
  console.log(
    `  reportedTotalDelta: ${fmt(result.identity.reportedTotalDelta)}   <- currentValue - reconstructedStartValue`,
  );
  const closes = result.identity.divergence === 0;
  console.log(
    `  DIVERGENCE:         ${fmt(result.identity.divergence)}  ${closes ? "✅ CLOSES" : "❌ MISMATCH"}`,
  );

  return closes;
}

async function main() {
  const userId = process.argv[2];
  const collectionId = process.argv[3] ?? null;
  if (!userId) {
    console.error(
      "Usage: npx ts-node scripts/validateMovers.ts <userId> [collectionId]",
    );
    process.exit(1);
  }

  console.log(
    `\n=== Portfolio Movers Validation — user ${userId}${collectionId ? ` collection ${collectionId}` : ""} ===`,
  );

  let allClosed = true;
  for (const window of WINDOWS) {
    try {
      const result = await getPortfolioMovers(userId, window, collectionId, "admin");
      const closed = printWindow(result);
      if (!closed) allClosed = false;
    } catch (err: any) {
      allClosed = false;
      console.error(`\nERROR running window ${window}:`, err?.message ?? err);
    }
  }

  console.log(
    allClosed
      ? "\n✅ PASS — identity closed to the cent on every window\n"
      : "\n❌ FAIL — nonzero divergence or error on at least one window\n",
  );
  process.exit(allClosed ? 0 : 1);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

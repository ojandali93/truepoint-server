// scripts/fullSync_pricecharting.ts
//
// Direct invocation of the real sync function (not the HTTP endpoint) over
// the FULL demand set (~494 cards as of 2026-08-25) — first full run,
// requested explicitly so it can be watched rather than fired-and-forgotten
// behind the endpoint's setImmediate.
//
// Usage: npx ts-node scripts/fullSync_pricecharting.ts

import "dotenv/config";
import { syncPriceChartingPrices, buildDemandSet } from "../src/services/pricechartingPriceSync.service";
import { supabaseAdmin } from "../src/lib/supabase";

async function main() {
  const demandSet = await buildDemandSet();
  console.log(`\n=== PriceCharting FULL sync — demand set: ${demandSet.length} cards ===`);
  console.log(`Expected wall time at 1.1s/call: ~${Math.round((demandSet.length * 1.1) / 60)} min\n`);

  const startedAt = new Date();
  const runStartIso = startedAt.toISOString();

  const summary = await syncPriceChartingPrices(demandSet);

  const finishedAt = new Date();
  const wallSeconds = (finishedAt.getTime() - startedAt.getTime()) / 1000;

  console.log("\n=== Summary ===");
  console.log(`Demand set size: ${summary.demandSetSize}`);
  console.log(`Processed:       ${summary.processed}`);
  console.log(`Matched:         ${summary.matched}`);
  console.log(`Unmatched:       ${summary.unmatched.length}`);
  console.log(`Graded rows:     ${summary.gradedRowsWritten}`);
  console.log(`Failed:          ${summary.failed}`);
  console.log(`Wall time:       ${Math.floor(wallSeconds / 60)}m ${Math.round(wallSeconds % 60)}s`);

  console.log(`\n=== Unmatched cards (${summary.unmatched.length}) ===`);
  for (const c of summary.unmatched) {
    console.log(`  ${c.cardId} | ${c.name} | ${c.number ?? "—"} | ${c.setName ?? "—"}`);
  }

  if (summary.failedCards.length) {
    console.log(`\n=== Failed cards (${summary.failedCards.length}) ===`);
    for (const f of summary.failedCards) {
      console.log(`  ${f.card.cardId} | ${f.card.name} — ${f.error}`);
    }
  }

  // Anomaly check — any error_logs rows written during this run under the
  // pricecharting sources (rate limits, auth issues, per-card failures
  // already surfaced above via failedCards, but this catches anything
  // logged without throwing, e.g. from pricechartingClient's own retries).
  const { data: errRows, error: errErr } = await supabaseAdmin
    .from("error_logs")
    .select("source, message, created_at")
    .in("source", ["pricecharting-auth", "pricecharting-get", "pricecharting-sync", "pricecharting-sync-fatal"])
    .gte("created_at", runStartIso)
    .order("created_at");

  console.log(`\n=== error_logs entries during this run ===`);
  if (errErr) {
    console.log(`  (read error: ${errErr.message})`);
  } else if (!errRows?.length) {
    console.log("  none");
  } else {
    for (const r of errRows) console.log(`  [${r.created_at}] ${r.source}: ${r.message}`);
  }

  console.log(`\nRun started ${runStartIso}, finished ${finishedAt.toISOString()}\n`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

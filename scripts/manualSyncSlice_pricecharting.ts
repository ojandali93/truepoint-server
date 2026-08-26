// scripts/manualSyncSlice_pricecharting.ts
//
// ONE-OFF manual verification run for Commit 3 (PriceCharting sync),
// per the approved plan's gate: sync a small hand-picked slice (not the
// full ~494-card demand set) and inspect what actually landed in
// market_prices before trusting the full sync. Real API calls, real DB
// writes (source='pricecharting' + 'pricecharting_meta' rows) — this IS
// production data, deliberately, per the approved gate.
//
// Slice: 6 cards already used in scripts/validateGradedPricePrecedence.ts
// (so this run's real PriceCharting numbers can be cross-checked against
// that script's fixtures) + Base Set Charizard (42382) specifically because
// it's the one card confirmed in Phase A to carry a BGS 10 Black Label
// price (condition-20-price) — the 3-token grade-string case — + 10 more
// diverse raw cards from the real demand set for variety.
//
// Usage: npx ts-node scripts/manualSyncSlice_pricecharting.ts

import "dotenv/config";
import { syncPriceChartingPrices } from "../src/services/pricechartingPriceSync.service";
import { supabaseAdmin } from "../src/lib/supabase";

const SLICE = [
  { cardId: "515364", name: "Gengar", number: "066/196", setName: "Prize Pack Series Cards" },
  { cardId: "662193", name: "Mega Sharpedo ex", number: "127/094", setName: "ME02: Phantasmal Flames" },
  { cardId: "662184", name: "Mega Charizard X ex", number: "125/094", setName: "ME02: Phantasmal Flames" },
  { cardId: "654521", name: "Mega Kangaskhan ex", number: "182/132", setName: "ME01: Mega Evolution" },
  { cardId: "662185", name: "Mega Charizard X ex", number: "130/094", setName: "ME02: Phantasmal Flames" },
  { cardId: "602681", name: "Umbreon ex", number: "217/187", setName: "SV8a: Terastal Fest ex" },
  { cardId: "42382", name: "Charizard", number: "004/102", setName: "Base Set" }, // Black Label case
  { cardId: "633043", name: "Jamming Tower", number: "243/182", setName: "SV10: Destined Rivals" },
  { cardId: "186022", name: "Jigglypuff (Holo Common)", number: "14/18", setName: "Detective Pikachu" },
  { cardId: "662170", name: "Ignition Energy", number: "124/094", setName: "ME02: Phantasmal Flames" },
  { cardId: "610387", name: "Iron Thorns ex", number: "032/131", setName: "SV: Prismatic Evolutions" },
  { cardId: "567297", name: "Iron Boulder", number: "071/142", setName: "SV07: Stellar Crown" },
  { cardId: "675880", name: "Hop's Pincurchin ex", number: "068/217", setName: "ME: Ascended Heroes" },
  { cardId: "623538", name: "Hop's Zacian ex", number: "111/159", setName: "SV09: Journey Together" },
  { cardId: "610372", name: "Hearthflame Mask Ogerpon ex", number: "017/131", setName: "SV: Prismatic Evolutions" },
  { cardId: "567474", name: "Galvantula ex", number: "168/142", setName: "SV07: Stellar Crown" },
  { cardId: "550088", name: "Goldeen", number: "044/167", setName: "SV06: Twilight Masquerade" },
].map((c) => ({ cardId: c.cardId, name: c.name, number: c.number, setName: c.setName }));

async function main() {
  console.log(`\n=== PriceCharting manual slice sync — ${SLICE.length} cards ===\n`);

  const summary = await syncPriceChartingPrices(SLICE);
  console.log("\nSummary:", summary);

  console.log("\n=== What landed in market_prices (source='pricecharting') ===\n");
  const cardIds = SLICE.map((c) => c.cardId);
  const { data, error } = await supabaseAdmin
    .from("market_prices")
    .select("card_id, source, grade, market_price, fetched_at")
    .in("card_id", cardIds)
    .in("source", ["pricecharting", "pricecharting_meta"])
    .order("card_id");

  if (error) {
    console.error("Read-back error:", error.message);
    process.exit(1);
  }

  for (const row of data ?? []) {
    const card = SLICE.find((c) => c.cardId === row.card_id);
    console.log(
      `  ${row.card_id} (${card?.name}) | source=${row.source} | grade=${row.grade ?? "—"} | ` +
        `market_price=${row.market_price ?? "—"} | fetched_at=${row.fetched_at}`,
    );
  }

  // Sanity checks specific to what the gate asked for.
  const charizardBlack = (data ?? []).find(
    (r) => r.card_id === "42382" && r.grade === "BGS 10 Black",
  );
  console.log(
    `\nBGS 10 Black Label (3-token grade string) landed for Base Set Charizard: ${
      charizardBlack ? `YES — $${charizardBlack.market_price}` : "NO"
    }`,
  );

  const kangaskhanRow = (data ?? []).find(
    (r) => r.card_id === "654521" && r.grade === "BGS 10" && r.source === "pricecharting",
  );
  console.log(
    `Kangaskhan BGS 10 pricecharting row landed: ${
      kangaskhanRow ? `YES — $${kangaskhanRow.market_price} (expect ~$247.77 per Phase 0)` : "NO"
    }`,
  );

  console.log("\nDone — inspect the rows above before running the full demand-set sync.\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });

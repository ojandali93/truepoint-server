// One-off: confirm fetchCardPrices' flag gate against the REAL rows just
// written by manualSyncSlice_pricecharting.ts (not synthetic fixtures this
// time — this is the actual production data).
import "dotenv/config";
import { fetchCardPrices } from "../src/repositories/inventory.repository";

async function main() {
  const ids = ["654521", "662193", "42382", "602681"];
  const off = await fetchCardPrices(ids, false);
  const on = await fetchCardPrices(ids, true);

  console.log("\n=== flag OFF (today's behavior, real rows now exist) ===");
  for (const id of ids) console.log(id, off.get(id));

  console.log("\n=== flag ON (amended contract) ===");
  for (const id of ids) console.log(id, on.get(id));
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });

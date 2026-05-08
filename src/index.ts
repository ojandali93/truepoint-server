import app from "./config/app";
import * as CardService from "./services/card.service";
import {
  syncAllCardPrices,
  shouldSyncPrices,
} from "./services/priceSync.service";
import { checkForNewSetsWithoutVariants } from "./services/variantSync.service";

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`TruePoint server running on port ${PORT}`);

  // Existing set sync
  const needsSetSync = await CardService.shouldSync();
  if (needsSetSync) {
    CardService.syncSets().catch((err) =>
      console.error("[Startup] Set sync failed:", err?.message),
    );
  }

  // Price sync — runs in background if stale
  const needsPriceSync = await shouldSyncPrices();
  if (needsPriceSync) {
    console.log("[Startup] Price sync needed — starting background sync...");
    syncAllCardPrices().catch((err) =>
      console.error("[Startup] Price sync failed:", err?.message),
    );
  }
  try {
    const newSets = await checkForNewSetsWithoutVariants();
    if (newSets.length > 0) {
      console.warn("═══════════════════════════════════════════════");
      console.warn("⚠️  NEW SETS WITHOUT VARIANT DATA DETECTED:");
      for (const setName of newSets) {
        console.warn(`   • ${setName}`);
      }
      console.warn("   → Go to /admin/variants to configure these sets");
      console.warn("   → Or run POST /sync/variants/{setId} to auto-sync");
      console.warn("═══════════════════════════════════════════════");
    }
  } catch (err: any) {
    console.error("[Startup] Variant check failed:", err?.message);
  }
});

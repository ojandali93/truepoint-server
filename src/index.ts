import app from "./config/app";
import * as CardService from "./services/card.service";

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`TruePoint server running on port ${PORT}`);

  // Sync sets on startup if stale
  try {
    const needsSetSync = await CardService.shouldSync();
    if (needsSetSync) {
      CardService.syncSets().catch((err) =>
        console.error("[Startup] Set sync failed:", err?.message),
      );
    }
  } catch (err: any) {
    console.error("[Startup] Set sync check failed:", err?.message);
  }
});

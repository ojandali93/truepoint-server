import app from './config/app';
import * as CardService from './services/card.service';

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`TruePoint server running on port ${PORT}`);
  try {
    const needsSync = await CardService.shouldSync();
    if (needsSync) {
      CardService.syncSets().catch((err) =>
        console.error('[Startup] Set sync failed:', err?.message ?? err)
      );
    }
  } catch (err) {
    console.error('[Startup] Could not check sync status:', err);
  }
});

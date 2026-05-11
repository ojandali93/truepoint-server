// src/routes/sync.routes.ts
// All sync operations now powered by TCGAPIs.com

import { Router, Request, Response } from 'express';
import { syncAllPortfolios } from '../services/portfolio.service';
import {
  syncAllSets,
  syncSetCards,
  syncSetGroupIds,
  refreshAllPrices,
  refreshPricesForSet,
} from '../services/tcgapisSync.service';

const router = Router();

const requireSyncKey = (req: Request, res: Response, next: Function): void => {
  const key = req.headers['x-sync-key'];
  if (!key || key !== process.env.SYNC_SECRET_KEY) {
    res.status(401).json({ error: 'Invalid sync key' });
    return;
  }
  next();
};

// POST /sync/tcgapis/map-sets — link sets to TCGAPIs groupIds
router.post('/tcgapis/map-sets', requireSyncKey, async (_req, res) => {
  try {
    const result = await syncSetGroupIds();
    res.json({ data: result, message: `Mapped ${result.mapped} sets. ${result.unmatched.length} unmatched.` });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

// POST /sync/tcgapis/all — full sync (weekly cron)
router.post('/tcgapis/all', requireSyncKey, async (_req, res) => {
  try {
    res.json({ message: 'Full TCGAPIs sync started in background.', timestamp: new Date().toISOString() });
    setImmediate(async () => {
      const result = await syncAllSets();
      console.log('[SyncRoute] Full TCGAPIs sync complete:', result);
    });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

// POST /sync/tcgapis/set/:setId — sync one set
router.post('/tcgapis/set/:setId', requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `TCGAPIs sync started for ${req.params.setId}` });
    setImmediate(async () => {
      const result = await syncSetCards(req.params.setId);
      console.log(`[SyncRoute] Set sync ${req.params.setId}:`, result);
    });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

// POST /sync/tcgapis/prices — daily price refresh (cron)
router.post('/tcgapis/prices', requireSyncKey, async (_req, res) => {
  try {
    res.json({ message: 'Daily price refresh started.', timestamp: new Date().toISOString() });
    setImmediate(async () => {
      const result = await refreshAllPrices();
      console.log('[SyncRoute] Price refresh complete:', result);
    });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

// POST /sync/tcgapis/prices/:setId — refresh one set prices
router.post('/tcgapis/prices/:setId', requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `Price refresh started for ${req.params.setId}` });
    setImmediate(async () => {
      const result = await refreshPricesForSet(req.params.setId);
      console.log(`[SyncRoute] Price refresh ${req.params.setId}:`, result);
    });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

// POST /sync/portfolio — daily portfolio snapshot (unchanged)
router.post('/portfolio', requireSyncKey, async (_req, res) => {
  try {
    res.json({ message: 'Portfolio snapshot sync started', timestamp: new Date().toISOString() });
    syncAllPortfolios().catch((err: any) =>
      console.error('[SyncRoute] Portfolio sync failed:', err?.message));
  } catch { res.status(500).json({ error: 'Failed to start portfolio sync' }); }
});

export default router;

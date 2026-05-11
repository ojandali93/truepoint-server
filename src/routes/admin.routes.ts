// src/routes/admin.routes.ts
import { Router, Response, Request } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { authenticateUser, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// ─── Analytics ────────────────────────────────────────────────────────────────

router.get('/analytics/users', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const { getUserStats } = await import('../services/adminAnalytics.service');
    res.json({ data: await getUserStats() });
  } catch { res.status(500).json({ error: 'Failed to get user stats' }); }
});

router.get('/analytics/collection', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const { getCollectionStats } = await import('../services/adminAnalytics.service');
    res.json({ data: await getCollectionStats() });
  } catch { res.status(500).json({ error: 'Failed to get collection stats' }); }
});

router.get('/analytics/sets', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const { getSetAnalytics } = await import('../services/adminAnalytics.service');
    res.json({ data: await getSetAnalytics() });
  } catch { res.status(500).json({ error: 'Failed to get set analytics' }); }
});

// ─── TCGAPIs sync controls (admin-triggered from UI) ─────────────────────────

router.post('/sync/map-sets', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    const { syncSetGroupIds } = await import('../services/tcgapisSync.service');
    const result = await syncSetGroupIds();
    res.json({ data: result });
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.post('/sync/all', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    res.json({ data: { message: 'Full TCGAPIs sync started in background.' } });
    const { syncAllSets } = await import('../services/tcgapisSync.service');
    setImmediate(() => syncAllSets().catch(console.error));
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.post('/sync/set/:setId', authenticateUser, requireAdmin, async (req, res) => {
  try {
    res.json({ data: { message: `Syncing set ${req.params.setId}...` } });
    const { syncSetCards } = await import('../services/tcgapisSync.service');
    setImmediate(() => syncSetCards(req.params.setId).catch(console.error));
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

router.post('/sync/prices', authenticateUser, requireAdmin, async (_req, res) => {
  try {
    res.json({ data: { message: 'Price refresh started in background.' } });
    const { refreshAllPrices } = await import('../services/tcgapisSync.service');
    setImmediate(() => refreshAllPrices().catch(console.error));
  } catch (err: any) { res.status(500).json({ error: err?.message }); }
});

export default router;

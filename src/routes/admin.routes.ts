// src/routes/admin.routes.ts
// Admin-only routes — protected by requireAdmin middleware

import { Router, Response, Request } from 'express';
import { supabaseAdmin } from '../lib/supabase';
import { authenticateUser, requireAdmin } from '../middleware/auth.middleware';

const router = Router();

// POST /admin/sets/tcgdex-ids
// Saves TCGdex ID mappings fetched from the browser (which can reach TCGdex,
// unlike the Render server which is IP-blocked).
// Body: { mappings: [{ setId: string, tcgdexId: string }] }

router.post(
  '/sets/tcgdex-ids',
  authenticateUser,
  requireAdmin,
  async (req: Request, res: Response) => {
    try {
      const { mappings } = req.body;

      if (!Array.isArray(mappings) || !mappings.length) {
        res.status(400).json({ error: 'mappings must be a non-empty array' });
        return;
      }

      let saved = 0;
      const errors: string[] = [];

      for (const { setId, tcgdexId } of mappings) {
        if (!setId || !tcgdexId) continue;

        const { error } = await supabaseAdmin
          .from('sets')
          .update({ tcgdex_id: tcgdexId })
          .eq('id', setId);

        if (error) {
          errors.push(`${setId}: ${error.message}`);
        } else {
          saved++;
        }
      }

      console.log(
        `[AdminRoute] Saved ${saved} TCGdex ID mappings` +
        (errors.length ? `, ${errors.length} errors` : '')
      );

      res.json({
        data: { saved, errors },
        message: `Saved ${saved} TCGdex ID mappings`,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to save TCGdex IDs' });
    }
  }
);


// ─── Analytics ────────────────────────────────────────────────────────────────

router.get(
  '/analytics/users',
  authenticateUser,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const { getUserStats } = await import('../services/adminAnalytics.service');
      const stats = await getUserStats();
      res.json({ data: stats });
    } catch {
      res.status(500).json({ error: 'Failed to get user stats' });
    }
  }
);

router.get(
  '/analytics/collection',
  authenticateUser,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const { getCollectionStats } = await import('../services/adminAnalytics.service');
      const stats = await getCollectionStats();
      res.json({ data: stats });
    } catch {
      res.status(500).json({ error: 'Failed to get collection stats' });
    }
  }
);

router.get(
  '/analytics/sets',
  authenticateUser,
  requireAdmin,
  async (_req: Request, res: Response) => {
    try {
      const { getSetAnalytics } = await import('../services/adminAnalytics.service');
      const stats = await getSetAnalytics();
      res.json({ data: stats });
    } catch {
      res.status(500).json({ error: 'Failed to get set analytics' });
    }
  }
);

export default router;


// ─── Add to src/config/app.ts ─────────────────────────────────────────────────
// import adminRoutes from '../routes/admin.routes';
// app.use('/api/v1/admin', adminRoutes);

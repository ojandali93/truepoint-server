/**
 * adminSync.routes.ts — manual, per-set sync controls for the admin panel.
 *
 * These mirror what the cron jobs do, but scoped to ONE set at a time and
 * gated behind admin auth (authenticateUser + requireAdmin) instead of the
 * x-sync-key header — so the admin UI never has to hold the sync secret.
 *
 * Mounted in app.ts:  app.use("/api/v1/admin", adminSyncRoutes);
 * Full paths:         /api/v1/admin/sync/...
 *
 * All actions are fire-and-forget: we respond 200 immediately and run the
 * work in the background (same pattern as sync.routes.ts). Check Render logs
 * for completion.
 */

import { Router, Request, Response } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import { syncSetCards } from "../services/tcgapisSync.service";
import { syncVariantPricesForSet } from "../services/variantPriceSync.service";
import { syncProductPricesForSet } from "../services/productPriceSync.service";
import { backfillSetImages } from "../services/setImageBackfill.service";
import { syncAllPortfolios } from "../services/portfolio.service";
import { fetchAndCacheGradedPrices } from "../services/poketracePriceSync.service";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const router = Router();

router.use(authenticateUser as any);
router.use(requireAdmin as any);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Run a fire-and-forget background job and report it started. */
function background(
  res: Response,
  label: string,
  job: () => Promise<unknown>,
  source: string,
) {
  res.json({ message: `${label} started — running in background.` });
  setImmediate(async () => {
    try {
      const r = await job();
      console.log(`[AdminSync] ${label} done:`, r ?? "ok");
    } catch (err: any) {
      console.error(`[AdminSync] ${label} failed:`, err?.message);
      await logError({
        source,
        message: err?.message ?? "Unknown error",
        error: err,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { label },
      });
    }
  });
}

// ─── Per-set: card variants (catalog) ────────────────────────────────────────
// POST /api/v1/admin/sync/set/:setId/cards
router.post("/sync/set/:setId/cards", (req: Request, res: Response) => {
  const { setId } = req.params;
  background(
    res,
    `Card/variant sync for set ${setId}`,
    () => syncSetCards(setId),
    "admin-sync-set-cards",
  );
});

// ─── Per-set: variant (raw) pricing ──────────────────────────────────────────
// POST /api/v1/admin/sync/set/:setId/variant-prices
router.post(
  "/sync/set/:setId/variant-prices",
  (req: Request, res: Response) => {
    const { setId } = req.params;
    background(
      res,
      `Variant price sync for set ${setId}`,
      () => syncVariantPricesForSet(setId),
      "admin-sync-set-variant-prices",
    );
  },
);

// ─── Per-set: sealed product pricing ─────────────────────────────────────────
// POST /api/v1/admin/sync/set/:setId/product-prices
router.post(
  "/sync/set/:setId/product-prices",
  (req: Request, res: Response) => {
    const { setId } = req.params;
    background(
      res,
      `Product price sync for set ${setId}`,
      () => syncProductPricesForSet(setId),
      "admin-sync-set-product-prices",
    );
  },
);

// ─── Per-set: graded (PokeTrace) pricing ─────────────────────────────────────
// No per-set graded function exists, so we walk the set's cards and warm the
// PokeTrace cache one at a time. The service's TTL means fresh cards are
// skipped cheaply, so re-runs are safe.
// POST /api/v1/admin/sync/set/:setId/graded
router.post("/sync/set/:setId/graded", (req: Request, res: Response) => {
  const { setId } = req.params;
  background(
    res,
    `Graded price sync for set ${setId}`,
    async () => {
      const { data: cards, error } = await supabaseAdmin
        .from("cards")
        .select("id")
        .eq("set_id", setId);
      if (error) throw new Error(error.message);
      const ids = (cards ?? []).map((c: { id: string }) => c.id);
      let warmed = 0;
      for (const id of ids) {
        try {
          await fetchAndCacheGradedPrices(id);
          warmed++;
        } catch (e: any) {
          console.error(`[AdminSync] graded ${id} failed:`, e?.message);
        }
        await sleep(150); // be gentle on PokeTrace / RapidAPI
      }
      return { cards: ids.length, warmed };
    },
    "admin-sync-set-graded",
  );
});

// ─── Global: set image backfill (fills nulls only) ───────────────────────────
// POST /api/v1/admin/sync/images
router.post("/sync/images", (_req: Request, res: Response) => {
  background(
    res,
    "Set image backfill",
    () => backfillSetImages(),
    "admin-sync-images",
  );
});

// ─── Global: portfolio snapshots (all users) ─────────────────────────────────
// POST /api/v1/admin/sync/portfolio
router.post("/sync/portfolio", (_req: Request, res: Response) => {
  background(
    res,
    "Portfolio snapshot sync",
    () => syncAllPortfolios(),
    "admin-sync-portfolio",
  );
});

export default router;

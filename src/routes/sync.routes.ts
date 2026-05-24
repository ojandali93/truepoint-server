// src/routes/sync.routes.ts
// All sync operations

import { Router, Request, Response } from "express";
import { syncAllPortfolios } from "../services/portfolio.service";
import * as CardService from "../services/card.service";
import {
  backfillAllCards,
  syncSingleSet,
  getSyncStatus,
} from "../services/cardSync.service";
import {
  syncAllSets,
  syncSetCards,
  syncSetGroupIds,
  refreshAllPrices,
  refreshPricesForSet,
} from "../services/tcgapisSync.service";
import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";
import {
  refreshAllSkuPrices,
  refreshSkuPricesForSet,
  syncAllSkus,
  syncSkusForSet,
} from "../services/tcgapisSkuSync.service";

const router = Router();

const requireSyncKey = (req: Request, res: Response, next: Function): void => {
  const key = req.headers["x-sync-key"];
  if (!key || key !== process.env.SYNC_SECRET_KEY) {
    res.status(401).json({ error: "Invalid sync key" });
    return;
  }
  next();
};

// ─── pokemontcg.io — Sets + Cards metadata ────────────────────────────────────

// POST /sync/sets — sync set list from pokemontcg.io
router.post("/sets", requireSyncKey, async (_req, res) => {
  try {
    const result = await CardService.syncSets();
    res.json({ data: result, message: `Synced ${result.synced} sets` });
  } catch (err: any) {
    await logError({
      source: "sync-pokemon-sets", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/cards — full card backfill from pokemontcg.io (all sets, all cards)
// Run this first after a fresh DB wipe to rebuild sets + cards tables
router.post("/cards", requireSyncKey, async (_req, res) => {
  try {
    res.json({
      message:
        "Full card sync started in background. This takes 30-90 minutes. Watch server logs.",
      timestamp: new Date().toISOString(),
    });
    setImmediate(async () => {
      await backfillAllCards();
    });
  } catch (err: any) {
    await logError({
      source: "sync-pokemon-cards", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/cards/:setId — sync one set's cards from pokemontcg.io
router.post("/cards/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `Card sync started for set ${req.params.setId}` });
    setImmediate(async () => {
      await syncSingleSet(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "get-sync-status", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// GET /sync/status — check sync status
router.get("/status", requireSyncKey, async (_req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({ data: status });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ─── TCGAPIs — Variants + Pricing ────────────────────────────────────────────

// POST /sync/tcgapis/map-sets — link sets to TCGAPIs groupIds (run after /sync/cards)
router.post("/tcgapis/map-sets", requireSyncKey, async (_req, res) => {
  try {
    const result = await syncSetGroupIds();
    res.json({
      data: result,
      message: `Mapped ${result.mapped} sets. ${result.unmatched.length} unmatched.`,
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-map-sets", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/tcgapis/all — full sync: variants + prices for all sets (weekly cron)
router.post("/tcgapis/all", requireSyncKey, async (_req, res) => {
  try {
    res.json({
      message: "Full TCGAPIs sync started in background.",
      timestamp: new Date().toISOString(),
    });
    setImmediate(async () => {
      await syncAllSets();
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-all", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/tcgapis/set/:setId — sync one set variants + prices
router.post("/tcgapis/set/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `TCGAPIs sync started for ${req.params.setId}` });
    setImmediate(async () => {
      await syncSetCards(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-set", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/tcgapis/prices — daily price refresh for all sets (daily cron)
router.post("/tcgapis/prices", requireSyncKey, async (_req, res) => {
  try {
    res.json({
      message: "Daily price refresh started.",
      timestamp: new Date().toISOString(),
    });
    setImmediate(async () => {
      await refreshAllPrices();
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-prices", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/tcgapis/prices/:setId — refresh prices for one set
router.post("/tcgapis/prices/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `Price refresh started for ${req.params.setId}` });
    setImmediate(async () => {
      await refreshPricesForSet(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-prices-set", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
});

// ─── Portfolio snapshots ──────────────────────────────────────────────────────

// POST /sync/portfolio — daily portfolio snapshot (daily cron)
router.post("/portfolio", requireSyncKey, async (_req, res) => {
  try {
    res.json({
      message: "Portfolio snapshot sync started",
      timestamp: new Date().toISOString(),
    });
    syncAllPortfolios().catch((err: any) =>
      console.error("[SyncRoute] Portfolio sync failed:", err?.message),
    );
  } catch {
    await logError({
      source: "sync-portfolio", // ← change per controller
      message: "Failed to start portfolio sync",
      error: null,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: "Failed to start portfolio sync" });
  }
});

// ADD THESE ROUTES to src/routes/sync.routes.ts
// (paste inside the existing router, after the existing TCGAPIs routes,
//  before `export default router;`)
//
// Also add this import at the top of the file:
//
//   import {
//     syncAllSkus,
//     syncSkusForSet,
//     refreshAllSkuPrices,
//     refreshSkuPricesForSet,
//   } from "../services/tcgapisSkuSync.service";
//   import { supabaseAdmin } from "../lib/supabase";

// ─── TCGAPIs — SKU-level catalog + pricing ───────────────────────────────────

// POST /sync/tcgapis/skus — refresh SKU prices for ALL sets (NIGHTLY CRON hot path)
router.post("/tcgapis/skus", requireSyncKey, async (_req, res) => {
  res.json({
    message: "SKU price refresh started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await refreshAllSkuPrices();
      console.log("[SKU-SYNC] refreshAllSkuPrices done:", r);
    } catch (err: any) {
      console.error("[SKU-SYNC] refreshAllSkuPrices failed:", err?.message);
    }
  });
});

// POST /sync/tcgapis/skus/full — full SKU catalog + price sync (run once / weekly)
router.post("/tcgapis/skus/full", requireSyncKey, async (_req, res) => {
  res.json({
    message: "Full SKU catalog + price sync started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await syncAllSkus();
      console.log("[SKU-SYNC] syncAllSkus done:", r);
    } catch (err: any) {
      console.error("[SKU-SYNC] syncAllSkus failed:", err?.message);
    }
  });
});

// POST /sync/tcgapis/skus/set/:setId — SKU catalog + prices for one set (TEST THIS FIRST)
router.post("/tcgapis/skus/set/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `SKU sync started for set ${req.params.setId}` });
  setImmediate(async () => {
    try {
      const r = await syncSkusForSet(req.params.setId);
      console.log(`[SKU-SYNC] set ${req.params.setId} done:`, r);
    } catch (err: any) {
      console.error(`[SKU-SYNC] set ${req.params.setId} failed:`, err?.message);
    }
  });
});

// POST /sync/tcgapis/skus/prices/:setId — price-only refresh for one set
router.post("/tcgapis/skus/prices/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `SKU price refresh started for ${req.params.setId}` });
  setImmediate(async () => {
    try {
      const r = await refreshSkuPricesForSet(req.params.setId);
      console.log(`[SKU-SYNC] price refresh ${req.params.setId}:`, r);
    } catch (err: any) {
      console.error(
        `[SKU-SYNC] price refresh ${req.params.setId} failed:`,
        err?.message,
      );
    }
  });
});

// GET /sync/tcgapis/health — observability for the nightly sync
router.get("/tcgapis/health", requireSyncKey, async (_req, res) => {
  try {
    const nowIso = new Date().toISOString();

    const [
      { data: lastSkuSync },
      { count: skusWithPrices },
      { count: staleSkus },
      { count: totalSkus },
    ] = await Promise.all([
      supabaseAdmin
        .from("price_sync_log")
        .select(
          "sync_type, status, synced_items, failed_items, started_at, completed_at",
        )
        .in("sync_type", ["skus", "prices"])
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("sku_prices")
        .select("id", { count: "exact", head: true })
        .gt("expires_at", nowIso),
      supabaseAdmin
        .from("sku_prices")
        .select("id", { count: "exact", head: true })
        .lt("expires_at", nowIso),
      supabaseAdmin
        .from("card_skus")
        .select("id", { count: "exact", head: true }),
    ]);

    res.json({
      data: {
        lastSync: lastSkuSync ?? null,
        skusInCatalog: totalSkus ?? 0,
        skusWithFreshPrices: skusWithPrices ?? 0,
        skusWithStalePrices: staleSkus ?? 0,
        checkedAt: nowIso,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

export default router;

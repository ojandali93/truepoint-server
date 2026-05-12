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
      const result = await backfillAllCards();
      console.log("[SyncRoute] Card backfill complete:", result);
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
      const count = await syncSingleSet(req.params.setId);
      console.log(
        `[SyncRoute] Card sync for ${req.params.setId}: ${count} cards`,
      );
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
      const result = await syncAllSets();
      console.log("[SyncRoute] Full TCGAPIs sync complete:", result);
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
      const result = await syncSetCards(req.params.setId);
      console.log(`[SyncRoute] Set sync ${req.params.setId}:`, result);
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
      const result = await refreshAllPrices();
      console.log("[SyncRoute] Price refresh complete:", result);
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
      const result = await refreshPricesForSet(req.params.setId);
      console.log(`[SyncRoute] Price refresh ${req.params.setId}:`, result);
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

export default router;

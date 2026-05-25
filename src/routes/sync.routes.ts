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
import {
  fillAllMetadata,
  fillMetadataForSet,
} from "../services/pokemontcgFallback.service";
import {
  syncCardsForSet,
  syncFullCatalog,
  syncSets as syncTcgapisSets,
} from "../services/catalogSync.service";
import {
  syncAllVariantPrices,
  syncVariantPricesForSet,
} from "../services/variantPriceSync.service";
import { syncProductPricesForSet } from "../services/productPriceSync.service";
import { syncAllProductPrices } from "../services/productPriceSync.service";
import { backfillSetImages } from "../services/setImageBackfill.service";

const router = Router();

const requireSyncKey = (req: Request, res: Response, next: Function): void => {
  const key = req.headers["x-sync-key"];
  if (!key || key !== process.env.SYNC_SECRET_KEY) {
    res.status(401).json({ error: "Invalid sync key" });
    return;
  }
  next();
};

// ════════════════════════════════════════════════════════════════════════════
// TCGAPIs-NATIVE CATALOG (PRIMARY) — sets + cards + sealed products
// ════════════════════════════════════════════════════════════════════════════

// POST /sync/catalog — full native catalog: sets + cards + sealed products
router.post("/catalog", requireSyncKey, async (_req, res) => {
  res.json({
    message: "TCGAPIs-native catalog sync started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await syncFullCatalog();
      console.log("[Catalog] syncFullCatalog done:", r);
    } catch (err: any) {
      console.error("[Catalog] syncFullCatalog failed:", err?.message);
    }
  });
});

// POST /sync/catalog/sets — just sets (fast)
router.post("/catalog/sets", requireSyncKey, async (_req, res) => {
  try {
    const r = await syncTcgapisSets();
    res.json({ data: r, message: `Synced ${r.synced} sets.` });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/catalog/set/:setId — one set's cards + sealed products (TEST FIRST)
router.post("/catalog/set/:setId", requireSyncKey, async (req, res) => {
  try {
    const r = await syncCardsForSet(req.params.setId);
    res.json({
      data: r,
      message: `Synced ${r.cards} cards + ${r.products} products for ${req.params.setId}`,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// TCGAPIs — NM-per-variant pricing (PRIMARY pricing path)
// ════════════════════════════════════════════════════════════════════════════

// POST /sync/prices — NM market price per variant for ALL sets (nightly cron)
router.post("/prices", requireSyncKey, async (_req, res) => {
  res.json({
    message: "NM variant price sync started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await syncAllVariantPrices();
      console.log("[VariantPrice] syncAllVariantPrices done:", r);
    } catch (err: any) {
      console.error("[VariantPrice] failed:", err?.message);
    }
  });
});

// POST /sync/prices/set/:setId — one set (TEST THIS FIRST)
router.post("/prices/set/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `Variant price sync started for ${req.params.setId}` });
  setImmediate(async () => {
    try {
      const r = await syncVariantPricesForSet(req.params.setId);
      console.log(`[VariantPrice] set ${req.params.setId}:`, r);
    } catch (err: any) {
      console.error(
        `[VariantPrice] set ${req.params.setId} failed:`,
        err?.message,
      );
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// pokemontcg.io FALLBACK — fill HP/types/supertype gaps (OPTIONAL)
// ════════════════════════════════════════════════════════════════════════════

// POST /sync/metadata — fill game metadata from pokemontcg for ALL sets
router.post("/metadata", requireSyncKey, async (_req, res) => {
  res.json({
    message: "Metadata fallback fill started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await fillAllMetadata();
      console.log("[PTCG-Fallback] fillAllMetadata done:", r);
    } catch (err: any) {
      console.error("[PTCG-Fallback] failed:", err?.message);
    }
  });
});

// POST /sync/metadata/:setId — fill metadata for one set
router.post("/metadata/:setId", requireSyncKey, async (req, res) => {
  try {
    const r = await fillMetadataForSet(req.params.setId);
    res.json({ data: r });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// Portfolio snapshots
// ════════════════════════════════════════════════════════════════════════════

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
      source: "sync-portfolio",
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

// GET /sync/status — check sync status
router.get("/status", requireSyncKey, async (_req, res) => {
  try {
    const status = await getSyncStatus();
    res.json({ data: status });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SEALED PRODUCT PRICING (OPTIONAL) — prices for the products table
// (uncomment + wire if/when you want booster box / ETB prices)
// ════════════════════════════════════════════════════════════════════════════
//
// import { syncAllProductsTcgapis, syncProductsForSet }
//   from "../services/tcgapisProductSync.service";
//
// router.post("/products", requireSyncKey, async (_req, res) => { ... });
// router.post("/products/:setId", requireSyncKey, async (req, res) => { ... });

// ════════════════════════════════════════════════════════════════════════════
// LEGACY / DEPRECATED — kept one release as a safety net. Do NOT use for the
// TCGAPIs-native flow. Retire after you're confident in the native pipeline.
// ════════════════════════════════════════════════════════════════════════════

// (pokemontcg) POST /sync/sets
router.post("/sets", requireSyncKey, async (_req, res) => {
  try {
    const result = await CardService.syncSets();
    res.json({ data: result, message: `Synced ${result.synced} sets` });
  } catch (err: any) {
    await logError({
      source: "sync-pokemon-sets",
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

// (pokemontcg) POST /sync/cards
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
      source: "sync-pokemon-cards",
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

// (pokemontcg) POST /sync/cards/:setId
router.post("/cards/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `Card sync started for set ${req.params.setId}` });
    setImmediate(async () => {
      await syncSingleSet(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "get-sync-status",
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

// (legacy tcgapis) POST /sync/tcgapis/map-sets
router.post("/tcgapis/map-sets", requireSyncKey, async (_req, res) => {
  try {
    const result = await syncSetGroupIds();
    res.json({
      data: result,
      message: `Mapped ${result.mapped} sets. ${result.unmatched.length} unmatched.`,
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-map-sets",
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

// (legacy tcgapis) POST /sync/tcgapis/all
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
      source: "sync-tcgapis-all",
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

// (legacy tcgapis) POST /sync/tcgapis/set/:setId
router.post("/tcgapis/set/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `TCGAPIs sync started for ${req.params.setId}` });
    setImmediate(async () => {
      await syncSetCards(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-set",
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

// (legacy tcgapis) POST /sync/tcgapis/prices
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
      source: "sync-tcgapis-prices",
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

// (legacy tcgapis) POST /sync/tcgapis/prices/:setId
router.post("/tcgapis/prices/:setId", requireSyncKey, async (req, res) => {
  try {
    res.json({ message: `Price refresh started for ${req.params.setId}` });
    setImmediate(async () => {
      await refreshPricesForSet(req.params.setId);
    });
  } catch (err: any) {
    await logError({
      source: "sync-tcgapis-prices-set",
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

// (legacy SKU — unused unless you do condition pricing) keep imports satisfied
router.post("/tcgapis/skus", requireSyncKey, async (_req, res) => {
  res.json({ message: "SKU price refresh started in background." });
  setImmediate(async () => {
    try {
      await refreshAllSkuPrices();
    } catch (err: any) {
      console.error("[SKU-SYNC] failed:", err?.message);
    }
  });
});
router.post("/tcgapis/skus/full", requireSyncKey, async (_req, res) => {
  res.json({ message: "Full SKU sync started in background." });
  setImmediate(async () => {
    try {
      await syncAllSkus();
    } catch (err: any) {
      console.error("[SKU-SYNC] failed:", err?.message);
    }
  });
});
router.post("/tcgapis/skus/set/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `SKU sync started for set ${req.params.setId}` });
  setImmediate(async () => {
    try {
      await syncSkusForSet(req.params.setId);
    } catch (err: any) {
      console.error(`[SKU-SYNC] ${req.params.setId} failed:`, err?.message);
    }
  });
});
router.post("/tcgapis/skus/prices/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `SKU price refresh started for ${req.params.setId}` });
  setImmediate(async () => {
    try {
      await refreshSkuPricesForSet(req.params.setId);
    } catch (err: any) {
      console.error(`[SKU-SYNC] ${req.params.setId} failed:`, err?.message);
    }
  });
});

// GET /sync/tcgapis/health — observability (last sync, fresh/stale counts)
router.get("/tcgapis/health", requireSyncKey, async (_req, res) => {
  try {
    const nowIso = new Date().toISOString();
    const [
      { data: lastSync },
      { count: freshPrices },
      { count: stalePrices },
      { count: totalCards },
    ] = await Promise.all([
      supabaseAdmin
        .from("price_sync_log")
        .select(
          "sync_type, status, synced_items, failed_items, started_at, completed_at",
        )
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabaseAdmin
        .from("market_prices")
        .select("id", { count: "exact", head: true })
        .gt("expires_at", nowIso),
      supabaseAdmin
        .from("market_prices")
        .select("id", { count: "exact", head: true })
        .lt("expires_at", nowIso),
      supabaseAdmin.from("cards").select("id", { count: "exact", head: true }),
    ]);
    res.json({
      data: {
        lastSync: lastSync ?? null,
        totalCards: totalCards ?? 0,
        pricesWithFresh: freshPrices ?? 0,
        pricesStale: stalePrices ?? 0,
        checkedAt: nowIso,
      },
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

// POST /sync/products/prices/:setId — one set's products (TEST THIS FIRST)
router.post("/products/prices/:setId", requireSyncKey, async (req, res) => {
  res.json({ message: `Product price sync started for ${req.params.setId}` });
  setImmediate(async () => {
    try {
      const r = await syncProductPricesForSet(req.params.setId);
      console.log(`[ProductPrice] set ${req.params.setId}:`, r);
    } catch (err: any) {
      console.error(
        `[ProductPrice] set ${req.params.setId} failed:`,
        err?.message,
      );
    }
  });
});

router.post("/products/prices", requireSyncKey, async (_req, res) => {
  res.json({
    message: "Product price sync started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await syncAllProductPrices();
      console.log("[ProductPrice] syncAllProductPrices done:", r);
    } catch (err: any) {
      console.error("[ProductPrice] failed:", err?.message);
    }
  });
});

router.post("/set-images", requireSyncKey, async (_req, res) => {
  res.json({
    message: "Set image backfill started in background.",
    timestamp: new Date().toISOString(),
  });
  setImmediate(async () => {
    try {
      const r = await backfillSetImages();
      console.log("[SetImages] backfill done:", r);
    } catch (err: any) {
      console.error("[SetImages] failed:", err?.message);
    }
  });
});

export default router;

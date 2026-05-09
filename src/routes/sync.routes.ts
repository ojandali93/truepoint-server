// src/routes/sync.routes.ts
import { Router, Request, Response } from "express";
import { syncAllProducts } from "../services/productSync.service";
import { syncAllPortfolios } from "../services/portfolio.service";
import {
  syncAllVariants,
  syncVariantsForSet,
  checkForNewSetsWithoutVariants,
} from "../services/variantSync.service";
import {
  backfillAllCards,
  syncSingleSet,
  getSyncStatus,
} from "../services/cardSync.service";
import { supabaseAdmin } from "../lib/supabase";
import {
  discoverTCGdexIds,
  getAllSetMappings,
} from "../services/setIdMapping.service";
import {
  fillMissingCardsFromTCGdex,
  fillAllSetsFromTCGdex,
} from "../services/tcgdexCardFill.service";

const router = Router();

// ─── Auth ─────────────────────────────────────────────────────────────────────

const requireSyncKey = (req: Request, res: Response, next: Function): void => {
  const key = req.headers["x-sync-key"];
  if (!key || key !== process.env.SYNC_SECRET_KEY) {
    res.status(401).json({ error: "Invalid sync key" });
    return;
  }
  next();
};

// ─── Card sync ────────────────────────────────────────────────────────────────

// POST /sync/cards/backfill
// Re-syncs any sets that are missing cards (incomplete syncs).
// Safe to run at any time — complete sets are skipped automatically.
router.post(
  "/cards/fill-all",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message: "TCGdex card fill started for all incomplete sets",
        timestamp: new Date().toISOString(),
      });
      fillAllSetsFromTCGdex()
        .then((result) => {
          console.log(
            `[SyncRoute] TCGdex fill complete: ${result.filled} sets filled, ` +
              `${result.alreadyComplete} already complete`,
          );
        })
        .catch((err) =>
          console.error("[SyncRoute] TCGdex fill failed:", err?.message),
        );
    } catch {
      res.status(500).json({ error: "Failed to start TCGdex fill" });
    }
  },
);

router.post(
  "/cards/backfill",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message:
          "Card backfill started — incomplete sets will be re-synced (this may take several minutes)",
        timestamp: new Date().toISOString(),
      });
      backfillAllCards()
        .then((result) => {
          console.log(
            `[SyncRoute] Card backfill complete: ${result.totalCards} cards, ` +
              `${result.completedSets} sets completed, ${result.failedSets.length} failed`,
          );
        })
        .catch((err) =>
          console.error("[SyncRoute] Card backfill failed:", err?.message),
        );
    } catch {
      res.status(500).json({ error: "Failed to start card backfill" });
    }
  },
);

// POST /sync/cards/:setId
// Force re-sync a specific set regardless of current card count.
router.post(
  "/cards/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { data: set } = await supabaseAdmin
        .from("sets")
        .select("name")
        .eq("id", setId)
        .single();

      if (!set) {
        res.status(404).json({ error: `Set ${setId} not found` });
        return;
      }

      res.json({
        message: `Card sync started for ${set.name} (${setId})`,
        setId,
      });
      syncSingleSet(setId)
        .then((count) =>
          console.log(`[SyncRoute] ✓ ${set.name}: ${count} cards synced`),
        )
        .catch((err) =>
          console.error(
            `[SyncRoute] Card sync failed for ${setId}:`,
            err?.message,
          ),
        );
    } catch {
      res.status(500).json({ error: "Failed to start card sync" });
    }
  },
);

// GET /sync/cards/status
// Shows which sets have incomplete card data.
router.get(
  "/cards/status",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      const status = await getSyncStatus();
      res.json({ data: status });
    } catch {
      res.status(500).json({ error: "Failed to get card sync status" });
    }
  },
);

// ─── Card prices ──────────────────────────────────────────────────────────────
// Prices are synced via CardMarket RapidAPI — use /prices/cardmarket endpoint.
// The old pokemontcg.io per-card sync has been removed (had ~30% coverage).

// ─── Product sync ─────────────────────────────────────────────────────────────

router.post(
  "/products",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message: "Product sync started",
        timestamp: new Date().toISOString(),
      });
      syncAllProducts().catch((err) =>
        console.error("[SyncRoute] Product sync failed:", err?.message),
      );
    } catch {
      res.status(500).json({ error: "Failed to start sync" });
    }
  },
);

router.post(
  "/products/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { data: set } = await supabaseAdmin
        .from("sets")
        .select("name")
        .eq("id", setId)
        .single();

      if (!set) {
        res.status(404).json({ error: `Set ${setId} not found` });
        return;
      }

      res.json({ message: `Product sync started for ${set.name}` });
      const { syncProductsForSet } =
        await import("../services/productSync.service");
      syncProductsForSet(setId, set.name).catch((err) =>
        console.error(
          `[SyncRoute] Product sync failed for ${setId}:`,
          err?.message,
        ),
      );
    } catch {
      res.status(500).json({ error: "Failed to start product sync" });
    }
  },
);

// ─── Portfolio snapshot ───────────────────────────────────────────────────────

router.post(
  "/portfolio",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message: "Portfolio snapshot sync started",
        timestamp: new Date().toISOString(),
      });
      syncAllPortfolios().catch((err) =>
        console.error("[SyncRoute] Portfolio sync failed:", err?.message),
      );
    } catch {
      res.status(500).json({ error: "Failed to start portfolio sync" });
    }
  },
);

// ─── Variant sync ─────────────────────────────────────────────────────────────

router.post(
  "/variants",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message:
          "Variant sync started for all sets (this takes several minutes)",
        timestamp: new Date().toISOString(),
      });
      syncAllVariants()
        .then((summary) => {
          console.log("[SyncRoute] Variant sync complete:", summary);
          if (summary.needsAttention.length > 0) {
            console.warn(
              "[SyncRoute] Sets needing admin attention:",
              summary.needsAttention
                .map((s) => `${s.setId} (${s.status})`)
                .join(", "),
            );
          }
        })
        .catch((err) =>
          console.error("[SyncRoute] Variant sync failed:", err?.message),
        );
    } catch {
      res.status(500).json({ error: "Failed to start variant sync" });
    }
  },
);

router.post(
  "/variants/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { data: set } = await supabaseAdmin
        .from("sets")
        .select("name")
        .eq("id", setId)
        .single();

      if (!set) {
        res.status(404).json({ error: `Set ${setId} not found` });
        return;
      }

      res.json({ message: `Variant sync started for ${set.name}`, setId });
      syncVariantsForSet(setId, set.name)
        .then((result) => {
          console.log(
            `[SyncRoute] Variant sync for ${setId}:`,
            result.status,
            `— ${result.variantsSaved} variants`,
          );
          if (result.missingFoilData) {
            console.warn(
              `[SyncRoute] ⚠️  ${set.name} has incomplete foil data — admin review needed`,
            );
          }
        })
        .catch((err) =>
          console.error(
            `[SyncRoute] Variant sync failed for ${setId}:`,
            err?.message,
          ),
        );
    } catch {
      res.status(500).json({ error: "Failed to start variant sync" });
    }
  },
);

router.get(
  "/variants/status",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      const [readySets, allSets] = await Promise.all([
        supabaseAdmin
          .from("set_variant_status")
          .select("set_id, status, variant_count, last_updated")
          .order("last_updated", { ascending: false }),
        supabaseAdmin
          .from("sets")
          .select("id, name")
          .order("release_date", { ascending: false }),
      ]);

      const readyMap = new Map(
        (readySets.data ?? []).map((r) => [r.set_id, r]),
      );

      const statusList = (allSets.data ?? []).map((set) => {
        const status = readyMap.get(set.id);
        return {
          setId: set.id,
          setName: set.name,
          status: status?.status ?? "pending",
          variantCount: status?.variant_count ?? 0,
          lastUpdated: status?.last_updated ?? null,
        };
      });

      const pending = statusList.filter((s) => s.status === "pending");
      const ready = statusList.filter((s) => s.status === "ready");

      res.json({
        data: {
          summary: {
            total: statusList.length,
            ready: ready.length,
            pending: pending.length,
          },
          pendingSets: pending,
          readySets: ready.slice(0, 20),
        },
      });
    } catch {
      res.status(500).json({ error: "Failed to get variant status" });
    }
  },
);

router.get(
  "/variants/diagnose/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { diagnoseTCGdexSet } =
        await import("../services/variantSync.service");
      const diagnosis = await diagnoseTCGdexSet(setId);

      res.json({
        data: {
          ...diagnosis,
          explanation: diagnosis.fullCardHasVariants
            ? "✅ TCGdex is returning variant data for this set"
            : "⚠️ TCGdex cards lack variant field — rarity rules will be used instead",
          idMatchRate:
            diagnosis.dbCards > 0
              ? `${diagnosis.matchedCards}/${diagnosis.dbCards} sample DB cards matched TCGdex IDs`
              : "No DB cards found for this set",
        },
      });
    } catch {
      res.status(500).json({ error: "Diagnosis failed" });
    }
  },
);

// ─── General status ───────────────────────────────────────────────────────────

router.get("/status", requireSyncKey, async (_req: Request, res: Response) => {
  try {
    const [priceLogs] = await Promise.all([
      supabaseAdmin
        .from("price_sync_log")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(5),
      supabaseAdmin
        .from("set_variant_status")
        .select("status, count:status")
        .in("status", ["ready", "pending"]),
    ]);

    const pendingSetsWarning = await checkForNewSetsWithoutVariants();

    res.json({
      data: {
        priceSyncLog: priceLogs.data ?? [],
        newSetsNeedingVariants: pendingSetsWarning,
      },
    });
  } catch {
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

// ─── Set ID mapping ───────────────────────────────────────────────────────────

// POST /sync/sets/map-tcgdex
// Auto-discovers TCGdex IDs for all sets and stores them.
// MUST run this before /sync/prices/tcgdex so sets have their tcgdex_id.
router.post(
  "/sets/map-tcgdex",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      const result = await discoverTCGdexIds();
      res.json({
        data: result,
        message: `Mapped ${result.matched} sets to TCGdex IDs. ${result.unmatched.length} could not be matched.`,
      });
    } catch {
      res.status(500).json({ error: "Failed to map TCGdex IDs" });
    }
  },
);

// GET /sync/sets/mappings
// Returns current set ID mapping table — our ID, TCGdex ID.
router.get(
  "/sets/mappings",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      const mappings = await getAllSetMappings();
      const withTCGdex = mappings.filter((m: any) => m.tcgdex_id);
      const without = mappings.filter((m: any) => !m.tcgdex_id);
      res.json({
        data: {
          total: mappings.length,
          mappedToTCGdex: withTCGdex.length,
          unmappedFromTCGdex: without.length,
          sets: mappings,
        },
      });
    } catch {
      res.status(500).json({ error: "Failed to get mappings" });
    }
  },
);

// ─── TCGdex card fill ─────────────────────────────────────────────────────────
// Fills in cards that pokemontcg.io doesn't have (SIRs, HRs above printed_total)
// using TCGdex as a fallback data source.

// POST /sync/cards/fill-all
// Fills missing cards for ALL sets using TCGdex

router.post(
  "/cards/fill/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { data: set } = await supabaseAdmin
        .from("sets")
        .select("name")
        .eq("id", setId)
        .single();

      if (!set) {
        res.status(404).json({ error: `Set ${setId} not found` });
        return;
      }

      res.json({
        message: `TCGdex card fill started for ${set.name}`,
        setId,
      });

      fillMissingCardsFromTCGdex(setId, set.name)
        .then((result) => {
          console.log(
            `[SyncRoute] TCGdex fill for ${setId}: ` +
              `inserted ${result.inserted}, status: ${result.status}`,
          );
          if (result.notes.length) {
            console.log(`  Notes: ${result.notes.join(", ")}`);
          }
        })
        .catch((err) =>
          console.error(
            `[SyncRoute] TCGdex fill failed for ${setId}:`,
            err?.message,
          ),
        );
    } catch {
      res.status(500).json({ error: "Failed to start TCGdex fill" });
    }
  },
);

// ─── CardMarket price sync ────────────────────────────────────────────────────
// Primary price source. Fetches TCGPlayer + CardMarket + graded prices
// for every card using the RapidAPI CardMarket endpoint.

// POST /sync/prices/cardmarket — sync ALL sets
router.post(
  "/prices/cardmarket",
  requireSyncKey,
  async (_req: Request, res: Response) => {
    try {
      res.json({
        message: "CardMarket bulk price sync started — syncing all sets",
        timestamp: new Date().toISOString(),
      });
      const { syncAllPricesFromCardMarket } =
        await import("../services/cardMarketPriceSync.service");
      syncAllPricesFromCardMarket().catch((err: any) =>
        console.error(
          "[SyncRoute] CardMarket price sync failed:",
          err?.message,
        ),
      );
    } catch {
      res.status(500).json({ error: "Failed to start CardMarket price sync" });
    }
  },
);

// POST /sync/prices/cardmarket/:setId — sync one set
router.post(
  "/prices/cardmarket/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      res.json({ message: `CardMarket price sync started for ${setId}` });
      const { syncSetPricesFromCardMarket } =
        await import("../services/cardMarketPriceSync.service");
      syncSetPricesFromCardMarket(setId).catch((err: any) =>
        console.error(
          `[SyncRoute] CardMarket price sync failed for ${setId}:`,
          err?.message,
        ),
      );
    } catch {
      res.status(500).json({ error: "Failed to start CardMarket price sync" });
    }
  },
);

// Add these two routes to src/routes/sync.routes.ts
// They test pricing sources directly from your Render server

// GET /sync/test/pokemontcg/:cardId
// Tests what pokemontcg.io returns for a specific card's prices
router.get(
  "/test/pokemontcg/:cardId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { cardId } = req.params;
      const { pokemonTcgClient } = await import("../lib/pokemonTcgClient");

      const card = await (pokemonTcgClient as any).getCardById(cardId);

      if (!card) {
        res
          .status(404)
          .json({ error: `Card ${cardId} not found in pokemontcg.io` });
        return;
      }

      res.json({
        data: {
          cardId: card.id,
          name: card.name,
          set: card.set?.name,
          hasTCGPlayerPrices: !!card.tcgplayer?.prices,
          tcgplayerUpdatedAt: card.tcgplayer?.updatedAt ?? null,
          tcgplayerPrices: card.tcgplayer?.prices ?? null,
          tcgplayerId: card.tcgplayer?.productId ?? null,
          hasCardMarketPrices: !!card.cardmarket?.prices,
          cardmarketPrices: card.cardmarket?.prices ?? null,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Test failed" });
    }
  },
);

// GET /sync/test/pokemontcg-set/:setId
// Tests price coverage across a full set from pokemontcg.io
// Returns how many cards have prices vs total
router.get(
  "/test/pokemontcg-set/:setId",
  requireSyncKey,
  async (req: Request, res: Response) => {
    try {
      const { setId } = req.params;
      const { pokemonTcgClient } = await import("../lib/pokemonTcgClient");

      // Fetch first page of cards for this set
      const result = await (pokemonTcgClient as any).getCardsBySet(
        setId,
        1,
        20,
      );
      const cards = result?.data ?? [];

      if (!cards.length) {
        res.json({ data: { setId, message: "No cards found", cards: [] } });
        return;
      }

      const sample = cards.slice(0, 5).map((c: any) => ({
        id: c.id,
        name: c.name,
        hasTCGPlayerPrices: !!c.tcgplayer?.prices,
        tcgplayerUpdatedAt: c.tcgplayer?.updatedAt ?? null,
        prices: c.tcgplayer?.prices ?? null,
        currency: "USD", // pokemontcg.io always returns USD
      }));

      const withPrices = cards.filter((c: any) => !!c.tcgplayer?.prices).length;

      res.json({
        data: {
          setId,
          totalFetched: cards.length,
          withPrices,
          coveragePct: Math.round((withPrices / cards.length) * 100),
          currency: "USD",
          sampleCards: sample,
        },
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Test failed" });
    }
  },
);

export default router;

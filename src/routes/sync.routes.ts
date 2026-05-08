// src/routes/sync.routes.ts
import { Router, Request, Response } from "express";
import { syncAllCardPrices } from "../services/priceSync.service";
import { syncAllProducts } from "../services/productSync.service";
import { syncAllPortfolios } from "../services/portfolio.service";
import {
  syncAllVariants,
  syncVariantsForSet,
  checkForNewSetsWithoutVariants,
} from "../services/variantSync.service";
import { supabaseAdmin } from "../lib/supabase";

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

// ─── Card prices ─────────────────────────────────────────────────────────────

router.post("/prices", requireSyncKey, async (_req: Request, res: Response) => {
  try {
    res.json({
      message: "Card price sync started",
      timestamp: new Date().toISOString(),
    });
    syncAllCardPrices().catch((err) =>
      console.error("[SyncRoute] Card price sync failed:", err?.message),
    );
  } catch {
    res.status(500).json({ error: "Failed to start sync" });
  }
});

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
// Pulls per-card variant data from TCGdex for all sets

// POST /sync/variants — sync all sets
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

// POST /sync/variants/:setId — sync a specific set
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

// GET /sync/variants/status — check which sets are missing variants
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
          readySets: ready.slice(0, 20), // most recently updated
        },
      });
    } catch (err) {
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
          explanation: diagnosis.hasVariantData
            ? "✅ TCGdex is returning variant data for this set"
            : "⚠️ TCGdex cards lack variant field — rarity rules will be used instead",
          idMatchRate:
            diagnosis.dbCards > 0
              ? `${diagnosis.matchedCards}/${diagnosis.dbCards} sample DB cards matched TCGdex IDs`
              : "No DB cards found for this set",
        },
      });
    } catch (err) {
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

export default router;

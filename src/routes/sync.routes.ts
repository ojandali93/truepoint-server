import { Router } from "express";
import { Request, Response } from "express";
import { syncAllCardPrices } from "../services/priceSync.service";
import {
  syncAllProducts,
  syncProductsForSet,
} from "../services/productSync.service";
import { syncAllPortfolios } from "../services/portfolio.service";

const router = Router();

// Middleware that checks the sync secret key
const requireSyncKey = (req: Request, res: Response, next: Function): void => {
  const key = req.headers["x-sync-key"];
  if (!key || key !== process.env.SYNC_SECRET_KEY) {
    res.status(401).json({ error: "Invalid sync key" });
    return;
  }
  next();
};

// Trigger price sync
router.post("/prices", requireSyncKey, async (_req: Request, res: Response) => {
  try {
    res.json({
      message: "Price sync started",
      timestamp: new Date().toISOString(),
    });
    syncAllCardPrices().catch((err) =>
      console.error("[SyncRoute] Price sync failed:", err?.message),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to start sync" });
  }
});

// Check sync status
router.get("/status", requireSyncKey, async (_req: Request, res: Response) => {
  try {
    const { supabaseAdmin } = await import("../lib/supabase");
    const { data } = await supabaseAdmin
      .from("price_sync_log")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(5);
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: "Failed to get sync status" });
  }
});

router.post("/products", requireSyncKey, async (_req, res) => {
  try {
    res.json({
      message: "Product sync started",
      timestamp: new Date().toISOString(),
    });
    syncAllProducts().catch((err) =>
      console.error("[SyncRoute] Product sync failed:", err?.message),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to start product sync" });
  }
});

// Sync products for a single set
router.post("/products/:setId", requireSyncKey, async (req, res) => {
  try {
    const { setId } = req.params;

    // Fetch set name from DB
    const { supabaseAdmin } = await import("../lib/supabase");
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
    syncProductsForSet(setId, set.name).catch((err) =>
      console.error(
        `[SyncRoute] Product sync failed for ${setId}:`,
        err?.message,
      ),
    );
  } catch (err) {
    res.status(500).json({ error: "Failed to start product sync" });
  }
});

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
    } catch (err) {
      res.status(500).json({ error: "Failed to start portfolio sync" });
    }
  },
);

export default router;

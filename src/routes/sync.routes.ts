import { Router } from "express";
import { Request, Response } from "express";
import { syncAllCardPrices } from "../services/priceSync.service";

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

export default router;

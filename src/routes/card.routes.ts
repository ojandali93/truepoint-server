import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
  adminLimiter,
} from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  identifyFromBase64Schema,
  identifyFromUrlSchema,
} from "../schemas/card.schemas";
import * as CardController from "../controllers/card.controller";
import * as CardSalesController from "../controllers/cardSales.controller";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const router = Router();

router.use(authenticateUser as any);

// ─── Sets ──────────────────────────────────────────────────────────────────────
router.get("/sets", standardLimiter, CardController.getAllSets as any);
router.get("/sets/:setId", standardLimiter, CardController.getSetById as any);
router.get(
  "/sets/:setId/cards",
  standardLimiter,
  CardController.getCardsBySet as any,
);

router.get(
  "/sets/:setId/prices",
  standardLimiter,
  CardController.getSetPrices as any,
);

// ─── Cards ─────────────────────────────────────────────────────────────────────
router.get("/search", standardLimiter, CardController.searchCards as any);
router.get(
  "/:cardId/prices",
  standardLimiter,
  CardController.getCardPrices as any,
);
router.get("/:cardId", standardLimiter, CardController.getCardById as any);
router.get(
  "/:cardId/recent-sales",
  standardLimiter,
  CardSalesController.getCardRecentSales as any,
);

// ─── Card Identification ───────────────────────────────────────────────────────
router.post(
  "/identify/base64",
  writeLimiter,
  validate(identifyFromBase64Schema),
  CardController.identifyCardFromBase64 as any,
);
router.post(
  "/identify/url",
  writeLimiter,
  validate(identifyFromUrlSchema),
  CardController.identifyCardFromUrl as any,
);

// ─── Admin ─────────────────────────────────────────────────────────────────────
router.post(
  "/admin/sync/sets",
  adminLimiter,
  requireAdmin as any,
  CardController.adminSyncSets as any,
);
router.post(
  "/admin/sync/cards",
  adminLimiter,
  requireAdmin as any,
  CardController.adminBackfillCards as any,
);
router.get(
  "/admin/sync/status",
  adminLimiter,
  requireAdmin as any,
  CardController.adminGetSyncStatus as any,
);
router.post(
  "/admin/sync/sets/:setId",
  adminLimiter,
  requireAdmin as any,
  CardController.adminSyncSingleSet as any,
);
router.delete(
  "/admin/prices/expired",
  adminLimiter,
  requireAdmin as any,
  CardController.adminPurgeExpiredPrices as any,
);

// Add to card.routes.ts
router.post(
  "/admin/sync/prices",
  adminLimiter,
  requireAdmin as any,
  CardController.adminTriggerPriceSync as any,
);
router.get(
  "/admin/sync/prices/status",
  adminLimiter,
  requireAdmin as any,
  CardController.adminGetSyncStatus as any,
);

router.get("/sealed/:setCode", standardLimiter, async (req, res) => {
  try {
    const { setCode } = req.params;

    const { data: products } = await supabaseAdmin
      .from("products")
      .select(
        `
        *,
        product_price_cache (
          source, low_price, mid_price, high_price, market_price, fetched_at
        )
      `,
      )
      .eq("set_id", setCode)
      .order("product_type");

    res.json({ data: products ?? [] });
  } catch (err: any) {
    await logError({
      source: "get-sealed-products", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    res.status(500).json({ error: "Failed to fetch products" });
  }
});

router.get("/search/global", standardLimiter, async (req, res) => {
  try {
    const q = (req.query.q as string)?.trim();
    if (!q || q.length < 2) {
      res.json({ data: { sets: [], cards: [], products: [] } });
      return;
    }

    const search = `%${q}%`;

    // Open-ended search: return every match, ordered by name. A high safety
    // ceiling guards against pathological substrings ("ex", "e") dumping the
    // whole table; an optional ?limit= can lower it. Frontend renders all rows.
    const MAX_RESULTS = 500;
    const limit = Math.min(
      Number(req.query.limit) > 0 ? Number(req.query.limit) : MAX_RESULTS,
      MAX_RESULTS,
    );

    const [setsResult, cardsResult, productsResult] = await Promise.all([
      supabaseAdmin
        .from("sets")
        .select("id, name, series, symbol_url, logo_url")
        .ilike("name", search)
        .order("name", { ascending: true })
        .limit(limit),

      supabaseAdmin
        .from("cards")
        .select("id, name, number, rarity, set_id, image_small")
        .ilike("name", search)
        .order("name", { ascending: true })
        .order("number", { ascending: true })
        .limit(limit),

      supabaseAdmin
        .from("products")
        .select("id, name, product_type, set_id, image_url")
        .ilike("name", search)
        .order("name", { ascending: true })
        .limit(limit),
    ]);

    res.json({
      data: {
        sets: setsResult.data ?? [],
        cards: cardsResult.data ?? [],
        products: productsResult.data ?? [],
      },
    });
  } catch (err: any) {
    await logError({
      source: "get-global-search", // ← change per controller
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

router.get(
  "/:cardId/graded-prices",
  standardLimiter,
  CardController.getCardGradedPrices as any,
);

router.get(
  "/:cardId/price-history",
  standardLimiter,
  CardController.getCardPriceHistory as any,
);

// ADD THIS BLOCK to src/routes/card.routes.ts immediately after the
// existing `/sealed/:setCode` handler (around line 135).
//
// Required for: /products/[productId] page on the website.
// Reads from products + product_price_cache exactly like the sealed list endpoint.

router.get("/product/:productId", standardLimiter, async (req, res) => {
  try {
    const { productId } = req.params;

    const { data: product, error } = await supabaseAdmin
      .from("products")
      .select(
        `
        *,
        product_price_cache (
          source, low_price, mid_price, high_price, market_price, fetched_at
        )
      `,
      )
      .eq("id", productId)
      .maybeSingle();

    if (error) {
      await logError({
        source: "get-product",
        message: error.message,
        error,
        userId: null,
        requestPath: req.path,
        requestMethod: req.method,
        metadata: { productId },
      });
      res.status(500).json({ error: "Failed to fetch product" });
      return;
    }

    if (!product) {
      res.status(404).json({ error: "Product not found" });
      return;
    }

    res.json({ data: product });
  } catch (err: any) {
    await logError({
      source: "get-product",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: {},
    });
    res.status(500).json({ error: "Failed to fetch product" });
  }
});

export default router;

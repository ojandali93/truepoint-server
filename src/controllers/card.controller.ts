import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { supabaseAdmin } from "../lib/supabase";
import * as CardService from "../services/card.service";
import * as CardIdentificationService from "../services/cardIdentification.service";
import * as PricingService from "../services/pricing.service";
import * as CardSyncService from "../services/cardSync.service";
import { refreshAllPrices } from "../services/tcgapisSync.service";
import { logError } from "../lib/Logger";
import {
  fetchAndCacheGradedPrices,
  getGradedPricesForCard,
} from "../services/poketracePriceSync.service";
import { resolveCardVariants } from "../services/variant.service";

// ─── Sets ─────────────────────────────────────────────────────────────────────

export const getAllSets = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sets = await CardService.getAllSets();
    res.json({ data: sets, count: sets.length });
  } catch (err: any) {
    await logError({
      source: "get-all-sets", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getSetById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const set = await CardService.getSetById(req.params.setId);
    res.json({ data: set });
  } catch (err: any) {
    await logError({
      source: "get-set-by-id", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getCardsBySet = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const result = await CardService.getCardsBySet(req.params.setId, page);
    res.json(result);
  } catch (err: any) {
    await logError({
      source: "get-cards-by-set", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Cards ────────────────────────────────────────────────────────────────────

export const getCardById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const card = await CardService.getCardById(req.params.cardId);
    res.json({ data: card });
  } catch (err: any) {
    await logError({
      source: "get-card-by-id", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const searchCards = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { q, setId, rarity, supertype, type, page, pageSize } =
      req.query as any;
    const result = await CardService.searchCards({
      q,
      setId,
      rarity,
      supertype,
      type,
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 20,
    });
    res.json(result);
  } catch (err: any) {
    await logError({
      source: "search-cards", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getCardPrices = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { cardId } = req.params;
    const card = await CardService.getCardById(cardId);
    const prices = await PricingService.getAllPricesForCard(cardId);

    // ── Align raw tcgplayer prices to the AUTHORITATIVE card_variants list ──
    // The card detail must show the same variants as the set browser. We drive
    // the list from card_variants (resolveCardVariants) and attach each
    // variant's price from market_prices (casing/separator-tolerant). Rows for
    // variants the card doesn't actually have (e.g. a stale reverse_holofoil)
    // are dropped; real variants with no price row still appear.
    const setId =
      (card as any).set?.id ?? (card as any).setId ?? (card as any).set_id;
    const authoritative = await resolveCardVariants(
      card.id,
      (card as any).rarity ?? "",
      setId,
    );

    const norm = (v: string | null | undefined) =>
      (v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

    const rawTcg = prices.tcgplayer.filter((p) => !p.grade);
    const gradedTcg = prices.tcgplayer.filter((p) => p.grade); // keep graded rows

    const alignedTcg = authoritative.map((vd) => {
      const match = rawTcg.find((p) => norm(p.variant) === norm(vd.type));
      return {
        cardId: card.id,
        source: "tcgplayer",
        variant: vd.type,
        variantLabel: vd.label,
        variantColor: vd.color,
        grade: null,
        lowPrice: match?.lowPrice ?? null,
        midPrice: match?.midPrice ?? null,
        highPrice: match?.highPrice ?? null,
        marketPrice: match?.marketPrice ?? null,
        fetchedAt: match?.fetchedAt ?? null,
      };
    });

    res.json({
      data: {
        card: { id: card.id, name: card.name, set: card.set.name },
        prices: {
          ...prices,
          tcgplayer: [...alignedTcg, ...gradedTcg],
        },
      },
    });
  } catch (err: any) {
    res
      .status(err?.statusCode ?? 500)
      .json({ error: err?.message ?? "Failed to load prices" });
  }
};

// ─── Card Identification ──────────────────────────────────────────────────────

export const identifyCardFromBase64 = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { image, mimeType } = req.body;
    const result = await CardIdentificationService.identifyFromBase64(
      image,
      mimeType,
    );
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "identify-card-from-base64", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const identifyCardFromUrl = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { imageUrl } = req.body;
    const result = await CardIdentificationService.identifyFromUrl(imageUrl);
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "identify-card-from-url", // ← c  hange per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Admin ────────────────────────────────────────────────────────────────────

export const adminSyncSets = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const result = await CardService.syncSets();
    res.json({ message: "Sync complete", ...result });
  } catch (err: any) {
    await logError({
      source: "admin-sync-sets", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminPurgeExpiredPrices = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { purgeExpiredPrices } =
      await import("../repositories/card.repository");
    await purgeExpiredPrices();
    res.json({ message: "Expired price cache purged" });
  } catch (err: any) {
    await logError({
      source: "admin-purge-expired-prices", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminGetSyncStatus = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const status = await CardSyncService.getSyncStatus();
    res.json({ data: status });
  } catch (err: any) {
    await logError({
      source: "admin-get-sync-status", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminBackfillCards = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    res.json({ message: "Card backfill started in background" });
    CardSyncService.backfillAllCards().catch((err) =>
      console.error("[BackfillCards] Failed:", err?.message),
    );
  } catch (err: any) {
    await logError({
      source: "admin-backfill-cards", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminSyncSingleSet = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const count = await CardSyncService.syncSingleSet(req.params.setId);
    res.json({ message: `Synced ${count} cards`, count });
  } catch (err: any) {
    await logError({
      source: "admin-sync-single-set", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const adminTriggerPriceSync = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    res.json({ message: "Price sync started in background" });
    refreshAllPrices().catch((err: unknown) =>
      console.error(
        "[PriceSync] Failed:",
        err instanceof Error ? err.message : err,
      ),
    );
  } catch (err: any) {
    await logError({
      source: "admin-trigger-price-sync", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (_req as any)?.userId ?? null,
      requestPath: _req.path,
      requestMethod: _req.method,
      metadata: { params: _req.params, query: _req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// GET /api/v1/cards/sets/:setId/prices
// Returns all cached raw card prices for every card in a set.
// Grouped by cardId → array of { variant, market, source }
export const getSetPrices = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { setId } = req.params;

    // Get card IDs for this set
    const { data: cards, error: cardsErr } = await supabaseAdmin
      .from("cards")
      .select("id")
      .eq("set_id", setId);

    if (cardsErr || !cards?.length) {
      return res.json({ data: {} });
    }

    const cardIds = cards.map((c) => c.id);

    // Fetch in batches of 200 to avoid URL limits
    const BATCH = 200;
    const allRows: any[] = [];

    for (let i = 0; i < cardIds.length; i += BATCH) {
      const batch = cardIds.slice(i, i + BATCH);
      const { data: rows, error: pricesErr } = await supabaseAdmin
        .from("market_prices")
        .select("card_id, source, variant, market_price, low_price, high_price")
        // flat columns — no 'prices' jsonb
        .in("card_id", batch)
        .is("grade", null) // raw cards only
        .gt("expires_at", new Date().toISOString());

      if (pricesErr) {
        console.error("[CardController] getSetPrices batch error:", pricesErr);
        continue;
      }
      allRows.push(...(rows ?? []));
    }

    // Build price map: cardId → [{ variant, market, source }]
    const priceMap: Record<
      string,
      {
        variant: string;
        market: number | null;
        low: number | null;
        source: string;
      }[]
    > = {};

    for (const row of allRows) {
      if (!priceMap[row.card_id]) priceMap[row.card_id] = [];
      priceMap[row.card_id].push({
        variant: row.variant ?? "normal",
        market: row.market_price ?? null,
        low: row.low_price ?? null,
        source: row.source,
      });
    }

    return res.json({ data: priceMap });
  } catch (err: any) {
    await logError({
      source: "get-set-prices", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    return res.status(500).json({ error: err?.message });
  }
};

export const getCardGradedPrices = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const cardId = req.params.cardId;
    if (!cardId) {
      res.status(400).json({ error: "cardId is required" });
      return;
    }
    const fetchResult = await fetchAndCacheGradedPrices(cardId);
    const prices = await getGradedPricesForCard(cardId);
    res.json({
      data: {
        cardId,
        cached: fetchResult.cached,
        prices,
      },
    });
  } catch (err: any) {
    console.error("[CardController] getCardGradedPrices:", err?.message);
    res
      .status(500)
      .json({ error: err?.message ?? "Failed to fetch graded prices" });
  }
};

export const getCardPriceHistory = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { cardId } = req.params;
    if (!cardId) {
      res.status(400).json({ error: "cardId is required" });
      return;
    }

    const rangeParam = (req.query.range as string) ?? "7d";
    const days = rangeParam === "30d" ? 30 : rangeParam === "90d" ? 90 : 7;

    // Compute the lower bound in UTC (YYYY-MM-DD) — matches how snapshotCardPrices
    // writes snapshot_date.
    const since = new Date();
    since.setUTCDate(since.getUTCDate() - days);
    const sinceDate = since.toISOString().slice(0, 10);

    const { data, error } = await supabaseAdmin
      .from("card_price_history")
      .select("snapshot_date, variant, market_price")
      .eq("card_id", cardId)
      .eq("source", "tcgplayer")
      .is("grade", null)
      .gte("snapshot_date", sinceDate)
      .order("snapshot_date", { ascending: true });

    if (error) {
      await logError({
        source: "get-card-price-history",
        message: error.message ?? "Failed to read card_price_history",
        error,
        userId: (req as any)?.userId ?? null,
        requestPath: req.path,
        requestMethod: req.method,
        metadata: { params: req.params, query: req.query },
      });
      res
        .status(500)
        .json({ error: error.message ?? "Failed to load history" });
      return;
    }

    // Bucket by variant. Skip rows with no usable price.
    const byVariant = new Map<string, { date: string; price: number }[]>();
    for (const row of data ?? []) {
      const v = (row as any).variant ?? "normal";
      const price = Number((row as any).market_price);
      if (!isFinite(price) || price <= 0) continue;
      const date = String((row as any).snapshot_date);
      const arr = byVariant.get(v) ?? [];
      arr.push({ date, price });
      byVariant.set(v, arr);
    }

    const series = Array.from(byVariant.entries()).map(([variant, points]) => ({
      variant,
      points,
    }));

    res.json({
      data: {
        range: days === 7 ? "7d" : days === 30 ? "30d" : "90d",
        series,
      },
    });
  } catch (err: any) {
    await logError({
      source: "get-card-price-history",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message ?? "Failed to load history" });
  }
};

// ─── Add to src/routes/card.routes.ts ────────────────────────────────────────
// Add this BEFORE the /:cardId route to avoid conflicts:

// router.get(
//   '/sets/:setId/prices',
//   standardLimiter,
//   CardController.getSetPrices as any
// );

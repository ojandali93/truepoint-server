import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as CardService from "../services/card.service";
import * as CardIdentificationService from "../services/cardIdentification.service";
import * as PricingService from "../services/pricing.service";
import * as CardSyncService from "../services/cardSync.service";
import { syncAllCardPrices } from "../services/priceSync.service";
import { supabaseAdmin } from "../lib";
import { TTL, TTLCache } from "../lib/cache";
import {
  ApiListResponse,
  CardSearchParams,
  PokemonCard,
} from "../types/pokemon.types";

const searchCache = new TTLCache<ApiListResponse<PokemonCard>>();

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[CardController Error]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// ─── Sets ─────────────────────────────────────────────────────────────────────

export const getAllSets = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const sets = await CardService.getAllSets();
    res.json({ data: sets, count: sets.length });
  } catch (err) {
    handleError(res, err);
  }
};

export const getSetById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const set = await CardService.getSetById(req.params.setId);
    res.json({ data: set });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

// ─── Cards ────────────────────────────────────────────────────────────────────

export const getCardById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const card = await CardService.getCardById(req.params.cardId);
    res.json({ data: card });
  } catch (err) {
    handleError(res, err);
  }
};

export const searchCards = async (
  params: CardSearchParams,
): Promise<ApiListResponse<PokemonCard>> => {
  const { q, setId, rarity, supertype, type, page = 1, pageSize = 20 } = params;
  const offset = (page - 1) * pageSize;

  const cacheKey = `search:${JSON.stringify(params)}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  let query = supabaseAdmin
    .from("cards")
    .select(
      `
      *,
      sets ( id, name )
    `,
      { count: "exact" },
    )
    .order("name")
    .range(offset, offset + pageSize - 1);

  // Apply filters
  if (q) {
    query = query.ilike("name", `%${q}%`);
  }
  if (setId) {
    query = query.eq("set_id", setId);
  }
  if (rarity) {
    query = query.eq("rarity", rarity);
  }
  if (supertype) {
    query = query.eq("supertype", supertype);
  }
  if (type) {
    query = query.contains("types", [type]);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error("[CardService] searchCards error:", error);
    throw { status: 500, message: "Search failed" };
  }

  const cards = (data ?? []).map((row: any) => ({
    id: row.id,
    name: row.name,
    number: row.number,
    supertype: row.supertype,
    subtypes: row.subtypes ?? [],
    hp: row.hp,
    types: row.types ?? [],
    rarity: row.rarity,
    set: {
      id: row.set_id,
      name: row.sets?.name ?? row.set_id,
    },
    images: {
      small: row.image_small,
      large: row.image_large,
    },
  })) as PokemonCard[];

  const result: ApiListResponse<PokemonCard> = {
    data: cards,
    page,
    pageSize,
    count: cards.length,
    totalCount: count ?? cards.length,
  };

  searchCache.set(cacheKey, result, TTL.CARDS);
  return result;
};

export const getCardPrices = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { cardId } = req.params;
    // Use CardService — not a local function
    const card = await CardService.getCardById(cardId);
    const prices = await PricingService.getAllPricesForCard(
      cardId,
      card.name,
      card.set.id,
    );
    res.json({
      data: {
        card: { id: card.id, name: card.name, set: card.set.name },
        prices,
      },
    });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const adminGetSyncStatus = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const status = await CardSyncService.getSyncStatus();
    res.json({ data: status });
  } catch (err) {
    handleError(res, err);
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
  } catch (err) {
    handleError(res, err);
  }
};

export const adminSyncSingleSet = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const count = await CardSyncService.syncSingleSet(req.params.setId);
    res.json({ message: `Synced ${count} cards`, count });
  } catch (err) {
    handleError(res, err);
  }
};

export const adminTriggerPriceSync = async (
  _req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    res.json({ message: "Price sync started in background" });
    syncAllCardPrices().catch((err) =>
      console.error("[PriceSync] Failed:", err?.message),
    );
  } catch (err) {
    handleError(res, err);
  }
};

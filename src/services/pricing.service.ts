// src/services/pricing.service.ts
// Complete pricing service — raw card prices from TCGPlayer (via pokemontcg.io),
// graded prices from CardMarket (via RapidAPI), and portfolio value resolution.

import { pokemonTcgClient } from "../lib/pokemonTcgClient";
import { cardMarketClient } from "../lib/cardMarketClient";
import { supabaseAdmin } from "../lib/supabase";
import { TTLCache, TTL } from "../lib/cache";
import type { NormalizedPrice } from "../types/pokemon.types";

const memCache = new TTLCache<NormalizedPrice[]>();

// ─── TTL constants ─────────────────────────────────────────────────────────────
const TTL_RAW_MS = 48 * 60 * 60 * 1000; // 48 hours for raw prices
const TTL_GRADED_MS = 72 * 60 * 60 * 1000; // 72 hours for graded prices

// ─── DB read ───────────────────────────────────────────────────────────────────

export const findCachedPrices = async (
  cardId: string,
  source?: string,
): Promise<NormalizedPrice[]> => {
  let q = supabaseAdmin
    .from("market_prices")
    .select("*")
    .eq("card_id", cardId)
    .gt("expires_at", new Date().toISOString());

  if (source) q = q.eq("source", source);

  const { data, error } = await q;
  if (error) {
    console.error("[PricingService] findCachedPrices error:", error.message);
    return [];
  }

  return (data ?? []).map((row: any) => ({
    cardId: row.card_id,
    source: row.source,
    variant: row.variant,
    grade: row.grade,
    lowPrice: row.low_price,
    midPrice: row.mid_price,
    highPrice: row.high_price,
    marketPrice: row.market_price,
    fetchedAt: row.fetched_at,
  }));
};

// ─── DB write ──────────────────────────────────────────────────────────────────

export const upsertPrices = async (
  prices: NormalizedPrice[],
  ttlMs: number,
): Promise<void> => {
  if (!prices.length) return;

  const cardId = prices[0].cardId;
  const sources = [...new Set(prices.map((p) => p.source))];
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();

  // Delete existing for this card+source combination
  await supabaseAdmin
    .from("market_prices")
    .delete()
    .eq("card_id", cardId)
    .in("source", sources);

  const rows = prices.map((p) => ({
    card_id: p.cardId,
    source: p.source,
    variant: p.variant ?? null,
    grade: p.grade ?? null,
    low_price: p.lowPrice ?? null,
    mid_price: p.midPrice ?? null,
    high_price: p.highPrice ?? null,
    market_price: p.marketPrice ?? null,
    fetched_at: p.fetchedAt,
    expires_at: expiresAt,
  }));

  const { error } = await supabaseAdmin.from("market_prices").insert(rows);

  if (error) {
    console.error("[PricingService] upsertPrices error:", error.message);
    throw error;
  }
};

// ─── TCGPlayer raw prices (pokemontcg.io embeds these) ─────────────────────────

const fetchTCGPlayerPrices = async (
  cardId: string,
): Promise<NormalizedPrice[]> => {
  try {
    const card = await pokemonTcgClient.getCardById(cardId);
    if (!card?.tcgplayer?.prices) return [];

    const now = new Date().toISOString();
    return Object.entries(card.tcgplayer.prices).map(
      ([variant, prices]: [string, any]) => ({
        cardId,
        source: "tcgplayer" as const,
        variant,
        grade: null,
        lowPrice: prices.low ?? null,
        midPrice: prices.mid ?? null,
        highPrice: prices.high ?? null,
        marketPrice: prices.market ?? null,
        fetchedAt: now,
      }),
    );
  } catch (err: any) {
    console.error(
      `[PricingService] TCGPlayer fetch failed for ${cardId}:`,
      err?.message,
    );
    return [];
  }
};

// ─── CardMarket graded prices (via RapidAPI) ───────────────────────────────────

const fetchGradedPrices = async (
  cardId: string,
  cardName: string,
  setId: string,
): Promise<NormalizedPrice[]> => {
  if (!process.env.RAPIDAPI_KEY) return [];

  try {
    const results = await cardMarketClient.searchCard(cardName, setId);
    if (!results?.length) return [];

    const data = results[0];
    const now = new Date().toISOString();
    const prices: NormalizedPrice[] = [];

    // CardMarket raw price
    if (data.prices?.cardmarket) {
      const cm = data.prices.cardmarket;
      prices.push({
        cardId,
        source: "cardmarket",
        variant: "normal",
        grade: null,
        lowPrice: cm.lowest_near_mint ?? null,
        midPrice: cm["7d_average"] ?? null,
        highPrice: cm["30d_average"] ?? null,
        marketPrice: cm["30d_average"] ?? cm["7d_average"] ?? null,
        fetchedAt: now,
      });

      // Graded prices from CardMarket
      const graded = cm.graded ?? {};
      const gradingCompanies = ["psa", "bgs", "cgc", "sgc"] as const;
      for (const company of gradingCompanies) {
        const companyGrades = (
          graded as Partial<
            Record<(typeof gradingCompanies)[number], Record<string, number>>
          >
        )[company];
        if (!companyGrades) continue;
        for (const [grade, price] of Object.entries(companyGrades)) {
          if (!price) continue;
          // Convert "psa10" → "PSA 10", "psa9" → "PSA 9" etc
          const gradeLabel = `${company.toUpperCase()} ${grade.replace(company, "")}`;
          prices.push({
            cardId,
            source: "cardmarket",
            variant: "normal",
            grade: gradeLabel,
            lowPrice: null,
            midPrice: null,
            highPrice: null,
            marketPrice: price,
            fetchedAt: now,
          });
        }
      }
    }

    // eBay graded prices
    if (data.prices?.ebay?.graded) {
      for (const [company, grades] of Object.entries(
        data.prices.ebay.graded as Record<string, any>,
      )) {
        for (const [grade, gradeData] of Object.entries(
          grades as Record<string, any>,
        )) {
          if (!gradeData?.median_price) continue;
          prices.push({
            cardId,
            source: "ebay",
            variant: "normal",
            grade: `${company.toUpperCase()} ${grade}`,
            lowPrice: null,
            midPrice: null,
            highPrice: null,
            marketPrice: gradeData.median_price,
            fetchedAt: now,
          });
        }
      }
    }

    return prices;
  } catch (err: any) {
    console.error(
      `[PricingService] CardMarket graded fetch failed for ${cardId}:`,
      err?.message,
    );
    return [];
  }
};

// ─── Public: get all prices for a card ────────────────────────────────────────
// Returns from cache if fresh, otherwise fetches and stores.

export const getAllPricesForCard = async (
  cardId: string,
  cardName: string,
  setId?: string,
  fetchGraded = false,
): Promise<{
  tcgplayer: NormalizedPrice[];
  cardmarket: NormalizedPrice[];
  ebay: NormalizedPrice[];
}> => {
  // Check memory cache first
  const memKey = `prices:${cardId}`;
  const memHit = memCache.get(memKey);
  if (memHit) {
    return {
      tcgplayer: memHit.filter((p) => p.source === "tcgplayer"),
      cardmarket: memHit.filter((p) => p.source === "cardmarket"),
      ebay: memHit.filter((p) => p.source === "ebay"),
    };
  }

  // Check DB cache
  const dbCached = await findCachedPrices(cardId);
  if (dbCached.length > 0) {
    memCache.set(memKey, dbCached, TTL.PRICES_RAW);
    return {
      tcgplayer: dbCached.filter((p) => p.source === "tcgplayer"),
      cardmarket: dbCached.filter((p) => p.source === "cardmarket"),
      ebay: dbCached.filter((p) => p.source === "ebay"),
    };
  }

  // Fetch fresh
  const [tcgPrices, gradedPrices] = await Promise.allSettled([
    fetchTCGPlayerPrices(cardId),
    // Only fetch graded if explicitly requested
    fetchGraded && setId
      ? fetchGradedPrices(cardId, cardName, setId)
      : Promise.resolve([]),
  ]);

  const allPrices = [
    ...(tcgPrices.status === "fulfilled" ? tcgPrices.value : []),
    ...(gradedPrices.status === "fulfilled" ? gradedPrices.value : []),
  ];

  // Store in DB
  if (allPrices.length > 0) {
    await upsertPrices(
      allPrices,
      allPrices.some((p) => p.grade) ? TTL_GRADED_MS : TTL_RAW_MS,
    ).catch((err) =>
      console.error(
        `[PricingService] Failed to store prices for ${cardId}:`,
        err?.message,
      ),
    );
    memCache.set(memKey, allPrices, TTL.PRICES_RAW);
  }

  return {
    tcgplayer: allPrices.filter((p) => p.source === "tcgplayer"),
    cardmarket: allPrices.filter((p) => p.source === "cardmarket"),
    ebay: allPrices.filter((p) => p.source === "ebay"),
  };
};

// ─── Resolve market value for inventory/portfolio ──────────────────────────────
// Returns the single best market price for a card, with fallback chain.

export const resolveMarketValue = async (
  cardId: string,
  cardName: string,
  setId?: string,
  gradingCompany?: string | null,
  grade?: string | null,
): Promise<{ price: number | null; source: string | null }> => {
  const cached = await findCachedPrices(cardId);

  if (gradingCompany && grade) {
    // Graded card — find matching graded price
    const gradeLabel = `${gradingCompany.toUpperCase()} ${grade}`;
    const graded = cached.find(
      (p) =>
        p.grade &&
        p.grade.toLowerCase() === gradeLabel.toLowerCase() &&
        p.marketPrice,
    );
    if (graded?.marketPrice)
      return { price: graded.marketPrice, source: graded.source };

    // Fallback to raw if no graded price
    const raw = cached.find(
      (p) => !p.grade && p.source === "tcgplayer" && p.marketPrice,
    );
    if (raw?.marketPrice)
      return { price: raw.marketPrice, source: "tcgplayer (raw fallback)" };
  } else {
    // Raw card — prefer TCGPlayer normal, then reverseHolofoil, then any
    const normalPrice = cached.find(
      (p) =>
        p.source === "tcgplayer" &&
        !p.grade &&
        (p.variant === "normal" || p.variant === "unlimited") &&
        p.marketPrice,
    );
    if (normalPrice?.marketPrice)
      return { price: normalPrice.marketPrice, source: "tcgplayer" };

    // Any TCGPlayer variant
    const anyTcg = cached.find(
      (p) => p.source === "tcgplayer" && !p.grade && p.marketPrice,
    );
    if (anyTcg?.marketPrice)
      return { price: anyTcg.marketPrice, source: "tcgplayer" };

    // CardMarket fallback
    const cm = cached.find(
      (p) => p.source === "cardmarket" && !p.grade && p.marketPrice,
    );
    if (cm?.marketPrice) return { price: cm.marketPrice, source: "cardmarket" };
  }

  // Nothing in cache — fetch live
  const prices = await getAllPricesForCard(cardId, cardName, setId);
  const tcgRaw = prices.tcgplayer.find((p) => !p.grade && p.marketPrice);
  if (tcgRaw?.marketPrice)
    return { price: tcgRaw.marketPrice, source: "tcgplayer" };

  return { price: null, source: null };
};

// ─── Batch resolve for inventory list ─────────────────────────────────────────
// Fetches all prices for a list of card IDs in one DB query.

export const batchResolveMarketValues = async (
  cardIds: string[],
): Promise<Map<string, number | null>> => {
  if (!cardIds.length) return new Map();

  const { data } = await supabaseAdmin
    .from("market_prices")
    .select("card_id, source, variant, grade, market_price")
    .in("card_id", cardIds)
    .is("grade", null)
    .gt("expires_at", new Date().toISOString());

  const priceMap = new Map<string, number | null>();

  // Priority: TCGPlayer normal > TCGPlayer any > CardMarket
  for (const row of data ?? []) {
    const existing = priceMap.get(row.card_id);
    if (existing != null) continue; // already have a price

    if (row.source === "tcgplayer" && row.market_price) {
      priceMap.set(row.card_id, row.market_price);
    }
  }

  // Fill in CardMarket for any still missing
  for (const row of data ?? []) {
    if (
      !priceMap.has(row.card_id) &&
      row.source === "cardmarket" &&
      row.market_price
    ) {
      priceMap.set(row.card_id, row.market_price);
    }
  }

  // Set null for any card IDs with no price
  for (const id of cardIds) {
    if (!priceMap.has(id)) priceMap.set(id, null);
  }

  return priceMap;
};

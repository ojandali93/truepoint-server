import { pokemonTcgClient } from "../lib/pokemonTcgClient";
import { cardMarketClient, CardMarketCard } from "../lib/cardMarketClient";
import { justTcgClient } from "../lib/justTcgClient";
import {
  findCachedPrices,
  upsertPrices,
} from "../repositories/card.repository";
import { NormalizedPrice, PokemonCard } from "../types/pokemon.types";
import { TTLCache, TTL } from "../lib/cache";

const priceMemoryCache = new TTLCache<NormalizedPrice[]>();

// ─── TCGPlayer (embedded in Pokémon TCG API response) ─────────────────────────

const normalizeTcgPlayerPrices = (card: PokemonCard): NormalizedPrice[] => {
  if (!card.tcgplayer?.prices) return [];
  return Object.entries(card.tcgplayer.prices).map(([variant, prices]) => ({
    cardId: card.id,
    source: "tcgplayer" as const,
    variant,
    grade: null,
    lowPrice: prices.low ?? null,
    midPrice: prices.mid ?? null,
    highPrice: prices.high ?? null,
    marketPrice: prices.market ?? null,
    fetchedAt: new Date().toISOString(),
  }));
};

// ─── CardMarket (via RapidAPI) ────────────────────────────────────────────────

const normalizeCardMarketPrices = (
  cardId: string,
  data: CardMarketCard,
): NormalizedPrice[] => {
  const prices: NormalizedPrice[] = [];
  const now = new Date().toISOString();

  if (data.prices.cardmarket) {
    const cm = data.prices.cardmarket;
    prices.push({
      cardId,
      source: "cardmarket",
      variant: "normal",
      grade: null,
      lowPrice: cm.lowest_near_mint ?? null,
      midPrice: cm["7d_average"] ?? null,
      highPrice: cm["30d_average"] ?? null,
      marketPrice: cm["30d_average"] ?? null,
      fetchedAt: now,
    });

    if (cm.graded?.psa?.psa10)
      prices.push({
        cardId,
        source: "cardmarket",
        variant: "normal",
        grade: "PSA 10",
        lowPrice: null,
        midPrice: null,
        highPrice: null,
        marketPrice: cm.graded.psa.psa10,
        fetchedAt: now,
      });
    if (cm.graded?.psa?.psa9)
      prices.push({
        cardId,
        source: "cardmarket",
        variant: "normal",
        grade: "PSA 9",
        lowPrice: null,
        midPrice: null,
        highPrice: null,
        marketPrice: cm.graded.psa.psa9,
        fetchedAt: now,
      });
    if (cm.graded?.cgc?.cgc10)
      prices.push({
        cardId,
        source: "cardmarket",
        variant: "normal",
        grade: "CGC 10",
        lowPrice: null,
        midPrice: null,
        highPrice: null,
        marketPrice: cm.graded.cgc.cgc10,
        fetchedAt: now,
      });
  }

  if (data.prices.ebay?.graded) {
    Object.entries(data.prices.ebay.graded).forEach(([company, grades]) => {
      Object.entries(grades).forEach(([gradeNum, gradeData]) => {
        prices.push({
          cardId,
          source: "ebay",
          variant: "normal",
          grade: `${company.toUpperCase()} ${gradeNum}`,
          lowPrice: null,
          midPrice: null,
          highPrice: null,
          marketPrice: gradeData.median_price ?? null,
          fetchedAt: now,
        });
      });
    });
  }

  if (data.prices.tcg_player?.market_price) {
    prices.push({
      cardId,
      source: "tcgplayer",
      variant: "normal",
      grade: null,
      lowPrice: null,
      midPrice: data.prices.tcg_player.mid_price ?? null,
      highPrice: null,
      marketPrice: data.prices.tcg_player.market_price,
      fetchedAt: now,
    });
  }

  return prices;
};

// ─── JustTCG ──────────────────────────────────────────────────────────────────

const normalizeJustTcgPrices = async (
  cardId: string,
  cardName: string,
  setCode?: string,
): Promise<NormalizedPrice[]> => {
  const results = await justTcgClient.searchCards(cardName, { setCode });
  const match = results.data[0];
  if (!match) return [];

  return match.prices.map((p) => ({
    cardId,
    source: "justtcg" as const,
    variant: p.condition,
    grade: null,
    lowPrice: p.price ?? null,
    midPrice: p.price ?? null,
    highPrice: null,
    marketPrice: p.foil_price ?? p.price ?? null,
    fetchedAt: new Date().toISOString(),
  }));
};

// ─── Public API ───────────────────────────────────────────────────────────────
export const getRawCardPrices = async (
  cardId: string,
): Promise<NormalizedPrice[]> => {
  console.log("[PricingService] Getting raw prices for:", cardId);

  // Temporarily bypass cache to debug
  const card = await pokemonTcgClient.getCardById(cardId);
  console.log(
    "[PricingService] TCG API card response tcgplayer:",
    card.tcgplayer,
  );

  const prices = normalizeTcgPlayerPrices(card);
  console.log("[PricingService] Normalized TCGPlayer prices:", prices);

  return prices;
};

export const getCardMarketPrices = async (
  cardId: string,
  cardMarketId?: number,
): Promise<NormalizedPrice[]> => {
  const cacheKey = `prices:cardmarket:${cardId}`;
  const memoryCached = priceMemoryCache.get(cacheKey);
  if (memoryCached) return memoryCached;

  const dbCached = await findCachedPrices(cardId, "cardmarket");
  if (dbCached.length > 0) {
    priceMemoryCache.set(cacheKey, dbCached, TTL.PRICES_RAW);
    return dbCached;
  }

  if (!process.env.RAPIDAPI_KEY) {
    console.warn(
      "[PricingService] RAPIDAPI_KEY not set — skipping CardMarket prices",
    );
    return [];
  }

  try {
    let data: CardMarketCard;
    if (cardMarketId) {
      data = await cardMarketClient.getCardPrices(cardMarketId);
    } else {
      const card = await pokemonTcgClient.getCardById(cardId);
      const searchResults = await cardMarketClient.searchCard(
        card.name,
        card.set.id,
      );
      if (!searchResults.length) return [];
      data = searchResults[0];
    }

    const prices = normalizeCardMarketPrices(cardId, data);
    if (prices.length > 0) {
      await upsertPrices(prices, TTL.PRICES_RAW);
      priceMemoryCache.set(cacheKey, prices, TTL.PRICES_RAW);
    }
    return prices;
  } catch (err) {
    console.error(
      "[PricingService] CardMarket fetch failed:",
      (err as any)?.message,
    );
    return [];
  }
};

export const getJustTcgPrices = async (
  cardId: string,
  cardName: string,
  setCode?: string,
): Promise<NormalizedPrice[]> => {
  const cacheKey = `prices:justtcg:${cardId}`;
  const memoryCached = priceMemoryCache.get(cacheKey);
  if (memoryCached) return memoryCached;

  const dbCached = await findCachedPrices(cardId, "justtcg");
  if (dbCached.length > 0) {
    priceMemoryCache.set(cacheKey, dbCached, TTL.PRICES_RAW);
    return dbCached;
  }

  if (!process.env.JUSTTCG_API_KEY) {
    console.warn(
      "[PricingService] JUSTTCG_API_KEY not set — skipping JustTCG prices",
    );
    return [];
  }

  try {
    const prices = await normalizeJustTcgPrices(cardId, cardName, setCode);
    if (prices.length > 0) {
      await upsertPrices(prices, TTL.PRICES_RAW);
      priceMemoryCache.set(cacheKey, prices, TTL.PRICES_RAW);
    }
    return prices;
  } catch (err) {
    console.error(
      "[PricingService] JustTCG fetch failed:",
      (err as any)?.message,
    );
    return [];
  }
};

export const getAllPricesForCard = async (
  cardId: string,
  cardName: string,
  setCode?: string,
): Promise<{
  tcgplayer: NormalizedPrice[];
  cardmarket: NormalizedPrice[];
  justtcg: NormalizedPrice[];
  ebay: NormalizedPrice[];
}> => {
  console.log("[PricingService] Fetching prices for:", cardId, cardName);

  const [raw, cm, jt] = await Promise.allSettled([
    getRawCardPrices(cardId),
    getCardMarketPrices(cardId),
    getJustTcgPrices(cardId, cardName, setCode),
  ]);

  console.log("[PricingService] raw result:", raw);
  console.log("[PricingService] cardmarket result:", cm);
  console.log("[PricingService] justtcg result:", jt);

  const all = [
    ...(raw.status === "fulfilled" ? raw.value : []),
    ...(cm.status === "fulfilled" ? cm.value : []),
    ...(jt.status === "fulfilled" ? jt.value : []),
  ];

  console.log("[PricingService] all prices combined:", all.length, "entries");

  return {
    tcgplayer: all.filter((p) => p.source === "tcgplayer"),
    cardmarket: all.filter((p) => p.source === "cardmarket"),
    justtcg: all.filter((p) => p.source === "justtcg"),
    ebay: all.filter((p) => p.source === "ebay"),
  };
};

export const invalidatePriceCache = (cardId: string): void => {
  ["raw", "cardmarket", "justtcg"].forEach((source) =>
    priceMemoryCache.delete(`prices:${source}:${cardId}`),
  );
};

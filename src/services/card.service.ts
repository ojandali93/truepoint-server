import { pokemonTcgClient } from "../lib/pokemonTcgClient";
import {
  findAllSets,
  findSetById,
  upsertSets,
  getLastSyncTime,
} from "../repositories/card.repository";
import { TTLCache, TTL } from "../lib/cache";
import {
  PokemonCard,
  PokemonSet,
  ApiListResponse,
  CardSearchParams,
} from "../types/pokemon.types";

const setsCache = new TTLCache<PokemonSet[]>();
const cardCache = new TTLCache<PokemonCard>();
const searchCache = new TTLCache<ApiListResponse<PokemonCard>>();

// ─── Sets ─────────────────────────────────────────────────────────────────────

export const getAllSets = async (): Promise<PokemonSet[]> => {
  const cached = setsCache.get("sets:all");
  if (cached) return cached;

  const dbSets = await findAllSets();
  if (dbSets.length > 0) {
    const sets = dbSets.map((row: any) => ({
      id: row.id,
      name: row.name,
      series: row.series,
      printedTotal: row.printed_total,
      total: row.total_cards_master, // ← was row.total
      releaseDate: row.release_date,
      images: { symbol: row.symbol_url, logo: row.logo_url },
    })) as PokemonSet[];
    setsCache.set("sets:all", sets, TTL.SETS);
    return sets;
  }

  const sets = await pokemonTcgClient.getSets();
  setsCache.set("sets:all", sets, TTL.SETS);
  return sets;
};

export const getSetById = async (setId: string): Promise<PokemonSet> => {
  const allCached = setsCache.get("sets:all");
  const fromList = allCached?.find((s) => s.id === setId);
  if (fromList) return fromList;

  const dbSet = await findSetById(setId);
  if (dbSet) {
    return {
      id: dbSet.id,
      name: dbSet.name,
      series: dbSet.series,
      printedTotal: dbSet.printed_total,
      total: dbSet.total,
      releaseDate: dbSet.release_date,
      images: { symbol: dbSet.symbol_url, logo: dbSet.logo_url },
    };
  }

  return pokemonTcgClient.getSetById(setId);
};

// ─── Cards ────────────────────────────────────────────────────────────────────

export const getCardsBySet = async (
  setId: string,
  page = 1,
): Promise<ApiListResponse<PokemonCard>> => {
  const cacheKey = `cards:set:${setId}:${page}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const result = await pokemonTcgClient.getCardsBySet(setId, page, 250);
  searchCache.set(cacheKey, result, TTL.CARDS);
  return result;
};

export const getCardById = async (cardId: string): Promise<PokemonCard> => {
  const cached = cardCache.get(cardId);
  if (cached) return cached;

  const card = await pokemonTcgClient.getCardById(cardId);
  cardCache.set(cardId, card, TTL.CARDS);
  return card;
};

export const searchCards = async (
  params: CardSearchParams,
): Promise<ApiListResponse<PokemonCard>> => {
  if (
    !params.q &&
    !params.setId &&
    !params.rarity &&
    !params.supertype &&
    !params.type
  ) {
    throw { status: 400, message: "At least one search parameter is required" };
  }

  const cacheKey = `search:${JSON.stringify(params)}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  const result = await pokemonTcgClient.searchCards(params);
  searchCache.set(cacheKey, result, TTL.SEARCH);
  return result;
};

// ─── Sync ─────────────────────────────────────────────────────────────────────

export const syncSets = async (): Promise<{
  synced: number;
  duration: number;
}> => {
  const start = Date.now();
  console.log("[SyncSets] Starting set sync...");

  const sets = await pokemonTcgClient.getSets();
  await upsertSets(sets);
  setsCache.delete("sets:all");

  const duration = Date.now() - start;
  console.log(`[SyncSets] Synced ${sets.length} sets in ${duration}ms`);
  return { synced: sets.length, duration };
};

export const shouldSync = async (): Promise<boolean> => {
  const lastSync = await getLastSyncTime();
  if (!lastSync) return true;
  const hoursSinceSync = (Date.now() - lastSync.getTime()) / (1000 * 60 * 60);
  return hoursSinceSync > 24;
};

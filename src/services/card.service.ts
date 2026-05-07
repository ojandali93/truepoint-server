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
import { supabaseAdmin } from "../lib/supabase";

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
  const pageSize = 250;
  const offset = (page - 1) * pageSize;
  const cacheKey = `cards:set:${setId}:${page}`;

  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  // Read from local Supabase cards table first
  const { data, error, count } = await supabaseAdmin
    .from("cards")
    .select("*", { count: "exact" })
    .eq("set_id", setId)
    .order("number")
    .range(offset, offset + pageSize - 1);

  if (!error && data && data.length > 0) {
    // Map DB columns to PokemonCard shape
    const cards = data.map((row: any) => ({
      id: row.id,
      name: row.name,
      number: row.number,
      supertype: row.supertype,
      subtypes: row.subtypes ?? [],
      hp: row.hp,
      types: row.types ?? [],
      rarity: row.rarity,
      set: { id: row.set_id, name: "" }, // name not stored in cards table
      images: {
        small: row.image_small,
        large: row.image_large,
      },
    })) as PokemonCard[];

    const result: ApiListResponse<PokemonCard> = {
      data: cards,
      page,
      pageSize,
      count: data.length,
      totalCount: count ?? data.length,
    };

    searchCache.set(cacheKey, result, TTL.CARDS);
    return result;
  }

  // Fallback to external API if cards not in DB yet
  console.log(
    `[CardService] No local cards for set ${setId}, falling back to API`,
  );
  const result = await pokemonTcgClient.getCardsBySet(setId, page, pageSize);
  searchCache.set(cacheKey, result, TTL.CARDS);
  return result;
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

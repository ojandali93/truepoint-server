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
const cardCache = new TTLCache<PokemonCard>(); // ← add this if missing
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

  return [];
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

  throw { status: 404, message: `Set ${setId} not found` };
};

// ─── Cards ────────────────────────────────────────────────────────────────────

export const getCardsBySet = async (
  setId: string,
  _page = 1, // kept for API compat — returns ALL cards, no 250 cap
): Promise<ApiListResponse<PokemonCard>> => {
  const cacheKey = `cards:set:${setId}:all`;

  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  // Fetch ALL cards from local DB — no 250 page limit.
  // Sets like Ascended Heroes (me2pt5) have 295 cards; capping at 250 breaks the browser.
  const { data, error, count } = await supabaseAdmin
    .from("cards")
    .select("*", { count: "exact" })
    .eq("set_id", setId)
    .order("number")
    .limit(2000); // safety ceiling — no TCG set exceeds this

  if (!error && data && data.length > 0) {
    const cards = data.map((row: any) => ({
      id: row.id,
      name: row.name,
      number: row.number,
      supertype: row.supertype,
      subtypes: row.subtypes ?? [],
      hp: row.hp,
      types: row.types ?? [],
      rarity: row.rarity,
      set: { id: row.set_id, name: "" },
      images: {
        small: row.image_small,
        large: row.image_large,
      },
    })) as PokemonCard[];

    const result: ApiListResponse<PokemonCard> = {
      data: cards,
      page: 1,
      pageSize: data.length,
      count: data.length,
      totalCount: count ?? data.length,
    };

    searchCache.set(cacheKey, result, TTL.CARDS);
    return result;
  }

  return { data: [], page: 1, pageSize: 0, count: 0, totalCount: 0 };
};

// ─── Sync ─────────────────────────────────────────────────────────────────────

export const syncSets = async (): Promise<{
  synced: number;
  duration: number;
}> => {
  const start = Date.now();
  console.log("[SyncSets] Starting set sync from pokemontcg.io...");

  // Fetch all sets directly from pokemontcg.io
  const axios = await import("axios");
  const response = await axios.default.get(
    "https://api.pokemontcg.io/v2/sets",
    {
      params: { orderBy: "-releaseDate", pageSize: 250 },
      headers: process.env.POKEMON_TCG_API_KEY
        ? { "X-Api-Key": process.env.POKEMON_TCG_API_KEY }
        : {},
      timeout: 60000,
    },
  );

  const sets = response.data?.data ?? [];
  if (sets.length === 0) throw new Error("No sets returned from pokemontcg.io");

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

export const getCardById = async (cardId: string): Promise<PokemonCard> => {
  const cached = cardCache.get(cardId);
  if (cached) return cached;

  // Try local DB first with set name join
  const { data, error } = await supabaseAdmin
    .from("cards")
    .select(`*, sets ( id, name, series, symbol_url, logo_url )`)
    .eq("id", cardId)
    .single();

  if (!error && data) {
    const card: PokemonCard = {
      id: data.id,
      name: data.name,
      number: data.number,
      supertype: data.supertype,
      subtypes: data.subtypes ?? [],
      hp: data.hp,
      types: data.types ?? [],
      rarity: data.rarity,
      set: {
        id: data.set_id,
        name: data.sets?.name ?? data.set_id,
      },
      images: {
        small: data.image_small,
        large: data.image_large,
      },
    };
    cardCache.set(cardId, card, TTL.CARDS);
    return card;
  }

  throw { status: 404, message: `Card ${cardId} not found` };
};

export const searchCards = async (
  params: CardSearchParams,
): Promise<ApiListResponse<PokemonCard>> => {
  const { q, setId, rarity, supertype, type, page = 1, pageSize = 20 } = params;
  const offset = (page - 1) * pageSize;

  // Build cache key from individual values — never JSON.stringify a params object
  const cacheKey = `search:${q ?? ""}:${setId ?? ""}:${rarity ?? ""}:${supertype ?? ""}:${type ?? ""}:${page}:${pageSize}`;
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;

  let query = supabaseAdmin
    .from("cards")
    .select("*, sets ( id, name )", { count: "exact" })
    .order("name")
    .range(offset, offset + pageSize - 1);

  if (q) query = query.ilike("name", `%${q}%`);
  if (setId) query = query.eq("set_id", setId);
  if (rarity) query = query.eq("rarity", rarity);
  if (supertype) query = query.eq("supertype", supertype);
  if (type) query = query.contains("types", [type]);

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

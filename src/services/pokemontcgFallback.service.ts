// src/services/pokemontcgFallback.service.ts
// FALLBACK ONLY: fills game metadata (supertype, subtypes, hp, types) that
// TCGAPIs doesn't provide. Matches pokemontcg.io cards to our (TCGAPIs-native)
// cards by SET NAME + CARD NUMBER. Never overwrites TCGAPIs data — only fills
// the four metadata fields, and only when they're empty.
//
// Skip this entirely if your UI doesn't display HP / types / supertype.

import axios from "axios";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const normalize = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

interface PtcgSet {
  id: string;
  name: string;
}

let ptcgSetCache: PtcgSet[] | null = null;

const loadPtcgSets = async (): Promise<PtcgSet[]> => {
  if (ptcgSetCache) return ptcgSetCache;
  const res = await axios.get("https://api.pokemontcg.io/v2/sets", {
    params: { pageSize: 250 },
    headers: process.env.POKEMON_TCG_API_KEY
      ? { "X-Api-Key": process.env.POKEMON_TCG_API_KEY }
      : {},
    timeout: 60000,
  });
  ptcgSetCache = (res.data?.data ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
  }));
  return ptcgSetCache!;
};

// ─── Fill metadata for one set ────────────────────────────────────────────────

export const fillMetadataForSet = async (
  setId: string,
): Promise<{ filled: number; matched: boolean }> => {
  // Our set
  const { data: ourSet } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .eq("id", setId)
    .single();
  if (!ourSet) return { filled: 0, matched: false };

  // Cards in our set missing metadata
  const { data: gaps } = await supabaseAdmin
    .from("cards")
    .select("id, number, supertype, hp")
    .eq("set_id", setId)
    .or("supertype.is.null,hp.is.null");

  if (!gaps?.length) return { filled: 0, matched: true };

  // Find the matching pokemontcg set by name
  const ptcgSets = await loadPtcgSets();
  const ptcgSet = ptcgSets.find(
    (s) => normalize(s.name) === normalize(ourSet.name),
  );
  if (!ptcgSet) return { filled: 0, matched: false };

  // Fetch all pokemontcg cards for that set, build number → card map
  const ptcgByNumber = new Map<string, any>();
  let page = 1;
  while (true) {
    try {
      const res = await axios.get("https://api.pokemontcg.io/v2/cards", {
        params: {
          q: `set.id:${ptcgSet.id}`,
          page,
          pageSize: 250,
          orderBy: "number",
        },
        headers: process.env.POKEMON_TCG_API_KEY
          ? { "X-Api-Key": process.env.POKEMON_TCG_API_KEY }
          : {},
        timeout: 120000,
      });
      const cards = res.data?.data ?? [];
      if (!cards.length) break;
      for (const pc of cards) {
        if (pc.number) {
          ptcgByNumber.set(String(pc.number), pc);
          ptcgByNumber.set(String(pc.number).replace(/^0+/, ""), pc);
        }
      }
      if (cards.length < 250) break;
      page++;
      await sleep(300);
    } catch (err: any) {
      await logError({
        source: "pokemontcg-fallback-fetch",
        message: err?.message ?? "fetch failed",
        error: err,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId, ptcgSetId: ptcgSet.id },
      });
      break;
    }
  }

  if (!ptcgByNumber.size) return { filled: 0, matched: true };

  // Match our gap cards by number, fill metadata
  let filled = 0;
  for (const card of gaps) {
    const numStripped = (card.number ?? "").replace(/^0+/, "");
    const pc =
      ptcgByNumber.get(card.number ?? "") ?? ptcgByNumber.get(numStripped);
    if (!pc) continue;

    await supabaseAdmin
      .from("cards")
      .update({
        supertype: pc.supertype ?? null,
        subtypes: pc.subtypes ?? [],
        hp: pc.hp ?? null,
        types: pc.types ?? [],
      })
      .eq("id", card.id);
    filled++;
  }

  return { filled, matched: true };
};

// ─── Fill metadata for all sets ───────────────────────────────────────────────

export const fillAllMetadata = async (): Promise<{
  setsProcessed: number;
  totalFilled: number;
  unmatchedSets: string[];
}> => {
  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .order("release_date", { ascending: false });

  let setsProcessed = 0;
  let totalFilled = 0;
  const unmatchedSets: string[] = [];

  for (const set of sets ?? []) {
    try {
      const r = await fillMetadataForSet(set.id);
      if (!r.matched) unmatchedSets.push(set.name);
      totalFilled += r.filled;
      setsProcessed++;
      await sleep(400);
    } catch (err: any) {
      console.error(`[PTCG-Fallback] set ${set.name} failed:`, err?.message);
    }
  }

  return { setsProcessed, totalFilled, unmatchedSets };
};

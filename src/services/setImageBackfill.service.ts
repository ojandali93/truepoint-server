// src/services/setImageBackfill.service.ts
//
// ONE-TIME (or occasional) backfill: fills sets.logo_url / sets.symbol_url from
// pokemontcg.io by matching on normalized set name (+ release year as a
// tiebreaker). TCGAPIs doesn't provide set logos, but pokemontcg.io hosts the
// real transparent-PNG logos. This ONLY writes the two image columns and ONLY
// when they're currently null — it never touches names, ids, series, cards,
// prices, or the sync pipeline.
//
// Safe to run anytime. Sets that don't match (e.g. brand-new Mega Evolution
// sets not yet in pokemontcg) are simply left blank.

import axios from "axios";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const normalize = (s: string) =>
  (s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

interface PtcgSet {
  id: string;
  name: string;
  releaseDate?: string; // "YYYY/MM/DD"
  images?: { symbol?: string; logo?: string };
}

const loadPtcgSets = async (): Promise<PtcgSet[]> => {
  const res = await axios.get("https://api.pokemontcg.io/v2/sets", {
    params: { pageSize: 250 },
    headers: process.env.POKEMON_TCG_API_KEY
      ? { "X-Api-Key": process.env.POKEMON_TCG_API_KEY }
      : {},
    timeout: 60000,
  });
  return (res.data?.data ?? []).map((s: any) => ({
    id: s.id,
    name: s.name,
    releaseDate: s.releaseDate,
    images: s.images,
  }));
};

const year = (d?: string | null): string => (d ?? "").slice(0, 4);

// Build a lookup: normalized name → PtcgSet[] (a name can repeat across years)
const indexByName = (sets: PtcgSet[]): Map<string, PtcgSet[]> => {
  const map = new Map<string, PtcgSet[]>();
  for (const s of sets) {
    const key = normalize(s.name);
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return map;
};

// Some TCGAPIs names carry a set-code prefix like "SM - Team Up" or
// "ME04: Chaos Rising". Try a few cleaned variants for matching.
const nameVariants = (raw: string): string[] => {
  const base = normalize(raw);
  const stripped = normalize(
    raw
      .replace(/^[A-Za-z]{1,4}\d*\s*[:\-]\s*/, "") // "ME04: " / "SM - "
      .replace(/\s*\(.*?\)\s*/g, " "), // parentheticals
  );
  return Array.from(new Set([base, stripped])).filter(Boolean);
};

export const backfillSetImages = async (): Promise<{
  total: number;
  matched: number;
  filled: number;
  unmatched: string[];
}> => {
  const ptcg = await loadPtcgSets();
  const byName = indexByName(ptcg);

  // Only sets currently missing images
  const { data: ourSets } = await supabaseAdmin
    .from("sets")
    .select("id, name, release_date, logo_url, symbol_url");

  const targets = (ourSets ?? []).filter((s) => !s.logo_url || !s.symbol_url);

  let matched = 0;
  let filled = 0;
  const unmatched: string[] = [];

  for (const set of targets) {
    let candidates: PtcgSet[] = [];
    for (const variant of nameVariants(set.name)) {
      candidates = byName.get(variant) ?? [];
      if (candidates.length) break;
    }

    if (!candidates.length) {
      unmatched.push(set.name);
      continue;
    }

    // If multiple same-name sets, prefer the one whose release year matches.
    let chosen = candidates[0];
    if (candidates.length > 1) {
      const sameYear = candidates.find(
        (c) => year(c.releaseDate) === year(set.release_date),
      );
      if (sameYear) chosen = sameYear;
    }

    const logo = chosen.images?.logo ?? null;
    const symbol = chosen.images?.symbol ?? null;
    if (!logo && !symbol) {
      unmatched.push(set.name);
      continue;
    }

    matched++;

    const update: Record<string, string> = {};
    if (!set.logo_url && logo) update.logo_url = logo;
    if (!set.symbol_url && symbol) update.symbol_url = symbol;
    if (Object.keys(update).length === 0) continue;

    const { error } = await supabaseAdmin
      .from("sets")
      .update(update)
      .eq("id", set.id);

    if (error) {
      await logError({
        source: "set-image-backfill",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId: set.id, name: set.name },
      });
    } else {
      filled++;
    }

    await sleep(20);
  }

  return { total: targets.length, matched, filled, unmatched };
};

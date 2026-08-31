// src/services/setImageBackfill.service.ts
//
// ONE-TIME (or occasional) backfill: fills sets.logo_url / sets.symbol_url from
// pokemontcg.io (English Pokémon) and TCGdex (Japanese Pokémon, see
// backfillJapaneseSetImagesFromTcgdex below) by matching on set name/code,
// then MIRRORING the matched art into our own "set-logos" Supabase bucket
// (Phase 2, 2026-09-01 — see src/lib/setLogoStorage.ts) rather than
// hotlinking the source directly. TCGAPIs itself doesn't provide set logos
// (its /expansions payload is groupId/name/abbreviation/publishedOn only —
// no images field, confirmed against the typed response in
// tcgapisSync.service.ts), which is why an external art source is needed at
// all. This ONLY writes the two image columns and ONLY when they're
// currently null — it never touches names, ids, series, cards, prices, or
// the sync pipeline.
//
// SCOPE (2026-08-31 fix): pokemontcg.io is an English-only Pokémon source.
// It has zero One Piece coverage and its handful of Japanese-set overlaps
// are coincidental, not real — a prior run matched our Japanese "SM6:
// Forbidden Light" onto pokemontcg.io's *English* "Forbidden Light" logo via
// prefix-stripping alone, no language check. That's exactly the
// wrong-art-via-force-match failure mode this backfill needs to avoid. So
// this only ever attempts game='pokemon' + language='English' rows.
// Everything else (One Piece entirely, Japanese Pokémon sets) is a known,
// permanent gap for this source — reported separately as `skippedNoSource`,
// never fed through the matcher.
//
// Root cause of the original 1/619 match rate: normalize() collapsed
// accented characters and "&" to nothing instead of folding them, so
// "Pokémon GO" vs "Pokemon GO" and "Diamond & Pearl" vs "Diamond and Pearl"
// missed each other on otherwise-identical names. Fixed below. The
// remainder were genuine renames between the two catalogs (our "Base Set"
// is pokemontcg.io's "Base", our "Expedition" is their "Expedition Base
// Set", era promo sets use "X Black Star Promos" there vs "X Promos" here,
// etc.) — those go through SET_NAME_ALIASES, verified 2026-08-31 against a
// live pull of all 174 pokemontcg.io sets. Sets with no real pokemontcg.io
// counterpart at all (brand-new products, retailer-exclusive promo
// groupings TCGplayer tracks as pseudo-sets, per-half-deck trainer kits for
// eras pokemontcg.io never split out) are left unmatched by design — see
// the "reason" on each entry in `unmatched`.
//
// Safe to run anytime.

import axios from "axios";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { mirrorUrlToBucket } from "../lib/setLogoStorage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Strip diacritics (Pokémon -> Pokemon) and fold "&" to "and" before the
// existing alnum strip, so accent/ampersand variance between the two
// catalogs stops hiding otherwise-identical names from each other.
const normalize = (s: string) =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics, e.g. accented e -> e
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();

// Manual aliases for our <-> pokemontcg.io set-name pairs that name the same
// physical product/art but don't converge under normalize() + prefix
// stripping. Verified 2026-08-31 against a live /v2/sets pull (174 sets) —
// every right-hand value below was confirmed present at that time. Keyed by
// our exact `sets.name`; checked before normalized/variant matching.
const SET_NAME_ALIASES: Record<string, string> = {
  "Base Set": "Base",
  "Base Set (Shadowless)": "Base", // same box art; differs only in card border
  Expedition: "Expedition Base Set",
  "SM Base Set": "Sun & Moon",
  "XY Base Set": "XY",
  "SWSH01: Sword & Shield Base Set": "Sword & Shield",
  "SWSH: Sword & Shield Promo Cards": "SWSH Black Star Promos",
  "SV: Scarlet & Violet Promo Cards": "Scarlet & Violet Black Star Promos",
  "SM Promos": "SM Black Star Promos",
  "XY Promos": "XY Black Star Promos",
  "HGSS Promos": "HGSS Black Star Promos",
  "Nintendo Promos": "Nintendo Black Star Promos",
  "Black and White Promos": "BW Black Star Promos",
  "Diamond and Pearl Promos": "DP Black Star Promos",
  "EX Ruby and Sapphire": "Ruby & Sapphire",
  Rumble: "Pokémon Rumble",
  "McDonald's Promos 2011": "McDonald's Collection 2011",
  "McDonald's Promos 2012": "McDonald's Collection 2012",
  "McDonald's Promos 2014": "McDonald's Collection 2014",
  "McDonald's Promos 2015": "McDonald's Collection 2015",
  "McDonald's Promos 2016": "McDonald's Collection 2016",
  "McDonald's Promos 2017": "McDonald's Collection 2017",
  "McDonald's Promos 2018": "McDonald's Collection 2018",
  "McDonald's Promos 2019": "McDonald's Collection 2019",
  "McDonald's Promos 2022": "McDonald's Collection 2022",
  // Trainer kits ship one box covering two half-decks; pokemontcg.io tracks
  // each half-deck as its own set, both sharing one box logo. Only the EX
  // era has that pair there at all — BW/DP/HGSS/SM/XY trainer kits have no
  // pokemontcg.io counterpart and stay a genuine gap (see unmatched below).
  "EX Trainer Kit 1: Latias & Latios": "EX Trainer Kit Latias",
  "EX Trainer Kit 2: Plusle & Minun": "EX Trainer Kit 2 Plusle",
};

// ─── needs-alias backlog (as of 2026-08-31) ────────────────────────────────
// The 50 game='pokemon'/language='English' sets `backfillSetImages()` could
// not resolve on that date, i.e. every set that came back tagged
// `reason: "needs-alias"`. None of these have a real pokemontcg.io
// counterpart today — they're not a matching bug, they're either products
// too new to be indexed yet, or retailer/promo groupings TCGplayer tracks
// as pseudo-sets that pokemontcg.io doesn't track as sets at all. Kept here
// (not just in a session report) so a future pass adding an alias — or a
// second source for the ones that stay genuinely gapped — has the backlog
// next to the code that would consume it, instead of re-deriving this list
// from scratch. Re-run `backfillSetImages()` and diff its `unmatchedDetail`
// against this list before trusting it — pokemontcg.io adds sets over time
// and some of these will resolve on their own as it catches up.
//
// Too-new / not yet indexed by pokemontcg.io:
//   ME06: Delta Reign
//   ME: 30th Celebration Classic Collection
//   ME: 30th Celebration
//   ME: Mega Evolution Promo
//   MEE: Mega Evolution Energies
//   First Partner Collection 2026
//   McDonald's Promos 2023
//   McDonald's Promos 2024
//   Trick or Trade BOOster Bundle 2023
//   Trick or Trade BOOster Bundle 2024
//
// Retailer-exclusive / promo groupings TCGplayer tracks as pseudo-sets,
// with no pokemontcg.io set of their own:
//   Alternate Art Promos
//   Best of Promos
//   Burger King Promos
//   Countdown Calendar Promos
//   Kids WB Promos
//   McDonald's 25th Anniversary Promos
//   Pikachu World Collection Promos
//   Player Placement Trainer Promos
//   Professor Program Promos
//   WoTC Promo
//   League & Championship Cards
//   Prize Pack Series Cards
//   World Championship Decks
//   Deck Exclusives
//   Blister Exclusives
//   Jumbo Cards
//   e-Reader Sample Cards
//   Miscellaneous Cards & Products
//   Ash vs Team Rocket Deck Kit (JP Exclusive)
//   First Partner Pack
//
// Per-half-deck trainer kits pokemontcg.io never split out beyond the EX
// era (see the EX Trainer Kit aliases above — those two are the only pair
// that resolves):
//   BW Trainer Kit: Excadrill & Zoroark
//   DP Trainer Kit: Manaphy & Lucario
//   DP Training Kit 1 Blue
//   DP Training Kit 1 Gold
//   HGSS Trainer Kit: Gyarados & Raichu
//   SM Trainer Kit: Alolan Sandslash & Alolan Ninetales
//   SM Trainer Kit: Lycanroc & Alolan Raichu
//   XY Trainer Kit: Bisharp & Wigglytuff
//   XY Trainer Kit: Latias & Latios
//   XY Trainer Kit: Pikachu Libre & Suicune
//   XY Trainer Kit: Sylveon & Noivern
//
// Boxed reprint/exhibition products pokemontcg.io doesn't track as sets
// (no unique cards of their own):
//   Battle Academy
//   Battle Academy 2022
//   Battle Academy 2024
//   My First Battle
//   Trading Card Game Classic
//   Trick or Trade BOOster Bundle
//   EX Battle Stadium
//
// Sub-collections within a parent set pokemontcg.io does track — declined
// to alias onto the parent's logo since the sub-collection likely has its
// own distinct box art and force-matching to the wrong art is the exact
// failure this file exists to avoid; needs a human to confirm the art
// before aliasing:
//   Generations: Radiant Collection
//   Legendary Treasures: Radiant Collection
//
// ─── Japanese Pokémon backlog (TCGdex adapter, as of 2026-09-01) ──────────
// backfillJapaneseSetImagesFromTcgdex() ran against all 456 game='pokemon'/
// language='Japanese' sets missing images: matched 0, filled 0. Not a bug —
// see the adapter's own header comment for the confirmed reason (TCGdex has
// no logo and almost no symbol art for Japanese sets yet). Breakdown of the
// 456:
//   194 no-code-prefix   — free-form name, nothing to join on at all
//   143 not-in-tcgdex    — has a code, but no matching TCGdex id (spot-
//                          checked several: genuinely absent, not a casing/
//                          alias issue — see session report)
//   119 no-art-in-source — TCGdex has the exact set, just no image for it
// All 456 stay on the manual-upload path (adminSetLogo.controller.ts) for
// now. Re-run the adapter periodically — TCGdex is actively crowd-sourced
// and its JP coverage may fill in over time; the join logic itself is
// already correct and needs no further work, only TCGdex's own data does.

interface PtcgSet {
  id: string;
  name: string;
  releaseDate?: string; // "YYYY/MM/DD"
  images?: { symbol?: string; logo?: string };
}

// pokemontcg.io is flaky — a bare, empty-body Cloudflare 500 on /v2/sets
// happened twice in a row during this file's 2026-08-31 testing session and
// once for real on Render the same day (see error_logs, source
// 'set-image-backfill', 2026-08-31T21:53Z — request_path
// https://api.pokemontcg.io/v2/sets, status 500, empty responseBody). That
// run aborted here, before any matching or DB write — clean failure, no
// partial writes — but it aborted the whole backfill over one transient
// upstream hiccup with no retry at all. Retry/backoff here follows the same
// house convention as tcgapisGet() (src/lib/tcgapisClient.ts): 429 waits a
// fixed cooldown without burning an attempt, other failures get increasing
// backoff, only the final attempt's error propagates.
const loadPtcgSets = async (retries = 3): Promise<PtcgSet[]> => {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
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
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;

      if (status === 429) {
        await sleep(30000); // rate limited — wait, don't burn a retry
        continue;
      }
      if (i < retries - 1) {
        await sleep(2000 * (i + 1)); // transient — backoff and retry
        continue;
      }
    }
  }
  throw lastErr;
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

interface UnmatchedEntry {
  name: string;
  reason: "needs-alias";
}

interface SkippedEntry {
  name: string;
  game: string | null;
  language: string | null;
  reason: "no-source";
}

export const backfillSetImages = async (): Promise<{
  total: number;
  matched: number;
  filled: number;
  unmatched: string[];
  unmatchedDetail: UnmatchedEntry[];
  skippedNoSource: SkippedEntry[];
}> => {
  const ptcg = await loadPtcgSets();
  const byName = indexByName(ptcg);

  const { data: allSets } = await supabaseAdmin
    .from("sets")
    .select("id, name, release_date, logo_url, symbol_url, game, language");

  const missingImages = (allSets ?? []).filter(
    (s) => !s.logo_url || !s.symbol_url,
  );

  // pokemontcg.io can never legitimately fill One Piece or Japanese-Pokémon
  // rows — don't run them through the matcher at all (see file header).
  const targets = missingImages.filter(
    (s) => s.game === "pokemon" && s.language === "English",
  );
  const skippedNoSource: SkippedEntry[] = missingImages
    .filter((s) => !(s.game === "pokemon" && s.language === "English"))
    .map((s) => ({
      name: s.name,
      game: s.game,
      language: s.language,
      reason: "no-source",
    }));

  let matched = 0;
  let filled = 0;
  const unmatchedDetail: UnmatchedEntry[] = [];

  for (const set of targets) {
    let candidates: PtcgSet[] = [];

    const alias = SET_NAME_ALIASES[set.name];
    if (alias) {
      candidates = byName.get(normalize(alias)) ?? [];
    }

    if (!candidates.length) {
      for (const variant of nameVariants(set.name)) {
        candidates = byName.get(variant) ?? [];
        if (candidates.length) break;
      }
    }

    if (!candidates.length) {
      unmatchedDetail.push({ name: set.name, reason: "needs-alias" });
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
      unmatchedDetail.push({ name: set.name, reason: "needs-alias" });
      continue;
    }

    matched++;

    // Mirror into our own bucket instead of hotlinking pokemontcg.io
    // directly (Phase 2, 2026-09-01) — see setLogoStorage.ts header.
    const update: Record<string, string> = {};
    if (!set.logo_url && logo) {
      try {
        update.logo_url = await mirrorUrlToBucket(set.id, "logo", logo);
      } catch (err: any) {
        await logError({
          source: "set-image-backfill",
          message: `mirror logo failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: logo,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }
    if (!set.symbol_url && symbol) {
      try {
        update.symbol_url = await mirrorUrlToBucket(set.id, "symbol", symbol);
      } catch (err: any) {
        await logError({
          source: "set-image-backfill",
          message: `mirror symbol failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: symbol,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }
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

  return {
    total: targets.length,
    matched,
    filled,
    unmatched: unmatchedDetail.map((u) => u.name),
    unmatchedDetail,
    skippedNoSource,
  };
};

// ─── TCGdex adapter (Japanese Pokémon sets) ────────────────────────────────
//
// backfillSetImages() above deliberately never attempts language='Japanese'
// rows — pokemontcg.io has no real JP coverage (see its file-header note).
// TCGdex (https://api.tcgdex.net, no auth) is a real, actively-maintained
// alternative that DOES track Japanese sets — but joins on a different
// axis: not name (their names are native Japanese script — 拡張パック etc.
// — vs our TCGAPIs-sourced English/romanized names, so string-matching
// doesn't apply at all here), but on TCGdex's own per-set `id`, which turns
// out to reuse the same set-code convention our names already carry as a
// prefix (our "SM1M: Collection Moon" ↔ TCGdex id "SM1M", name "コレクショ
// ンムーン" — same set, same code, different script). So this is a
// code-extraction + case-insensitive ID join, not a name join.
//
// HONEST LIMIT, confirmed live 2026-09-01 against all 184 JP sets TCGdex
// currently has: 0 carry a `logo` field and only 4 carry `symbol` (the four
// oldest Neo-series sets) — checked the list endpoint, a set-detail
// endpoint, and the series endpoint. Contrast: TCGdex's English catalog has
// logo on 157/218 sets. TCGdex just hasn't digitized Japanese box art yet.
// So this adapter is correct, reusable, idempotent infrastructure that will
// pick up real coverage for free as TCGdex's JP catalog fills in over
// time — but today it will match only a handful of sets, not meaningfully
// close the ~450-set Japanese gap. That gap is the manual-upload path
// (adminSetLogo.controller.ts) by design, not a bug here.

interface TcgdexSet {
  id: string;
  name: string;
  logo?: string;
  symbol?: string;
}

const loadTcgdexJapaneseSets = async (retries = 3): Promise<TcgdexSet[]> => {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get<TcgdexSet[]>(
        "https://api.tcgdex.net/v2/ja/sets",
        { timeout: 30000 },
      );
      return res.data ?? [];
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 429) {
        await sleep(30000);
        continue;
      }
      if (i < retries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
    }
  }
  throw lastErr;
};

// Extracts the set-code prefix from a name like "SM1M: Collection Moon" ->
// "SM1M". Returns null when there's no colon-delimited code to extract
// (free-form names like "Elementary School Competition" have no TCGAPIs
// code at all and can never be joined this way).
const extractSetCode = (raw: string): string | null => {
  const m = raw.match(/^([^\s:]+):/);
  return m ? m[1] : null;
};

// Manual aliases for our code -> TCGdex id, for the rare case our TCGAPIs
// code doesn't literally match TCGdex's id even case-insensitively. Empty
// until a real run surfaces a genuine case — don't pre-guess entries.
const TCGDEX_CODE_ALIASES: Record<string, string> = {};

type JpUnmatchedReason = "no-code-prefix" | "not-in-tcgdex" | "no-art-in-source";

interface JpUnmatchedEntry {
  name: string;
  reason: JpUnmatchedReason;
}

export const backfillJapaneseSetImagesFromTcgdex = async (): Promise<{
  total: number;
  matched: number;
  filled: number;
  unmatched: string[];
  unmatchedDetail: JpUnmatchedEntry[];
}> => {
  const tcgdexSets = await loadTcgdexJapaneseSets();
  const byId = new Map<string, TcgdexSet>();
  for (const s of tcgdexSets) byId.set(s.id.toUpperCase(), s);

  const { data: allSets } = await supabaseAdmin
    .from("sets")
    .select("id, name, logo_url, symbol_url, game, language")
    .eq("game", "pokemon")
    .eq("language", "Japanese");

  const targets = (allSets ?? []).filter(
    (s) => !s.logo_url || !s.symbol_url,
  );

  let matched = 0;
  let filled = 0;
  const unmatchedDetail: JpUnmatchedEntry[] = [];

  for (const set of targets) {
    const code = extractSetCode(set.name);
    if (!code) {
      unmatchedDetail.push({ name: set.name, reason: "no-code-prefix" });
      continue;
    }

    const aliasedCode = TCGDEX_CODE_ALIASES[code] ?? code;
    const tcgdexSet = byId.get(aliasedCode.toUpperCase());
    if (!tcgdexSet) {
      unmatchedDetail.push({ name: set.name, reason: "not-in-tcgdex" });
      continue;
    }

    if (!tcgdexSet.logo && !tcgdexSet.symbol) {
      unmatchedDetail.push({ name: set.name, reason: "no-art-in-source" });
      continue;
    }

    matched++;

    const update: Record<string, string> = {};
    if (!set.logo_url && tcgdexSet.logo) {
      try {
        update.logo_url = await mirrorUrlToBucket(
          set.id,
          "logo",
          `${tcgdexSet.logo}.png`,
        );
      } catch (err: any) {
        await logError({
          source: "set-image-backfill-tcgdex",
          message: `mirror logo failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: `${tcgdexSet.logo}.png`,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }
    if (!set.symbol_url && tcgdexSet.symbol) {
      try {
        update.symbol_url = await mirrorUrlToBucket(
          set.id,
          "symbol",
          `${tcgdexSet.symbol}.png`,
        );
      } catch (err: any) {
        await logError({
          source: "set-image-backfill-tcgdex",
          message: `mirror symbol failed: ${err?.message}`,
          error: err,
          userId: null,
          requestPath: `${tcgdexSet.symbol}.png`,
          requestMethod: "GET",
          metadata: { setId: set.id, name: set.name },
        });
      }
    }
    if (Object.keys(update).length === 0) continue;

    const { error } = await supabaseAdmin
      .from("sets")
      .update(update)
      .eq("id", set.id);

    if (error) {
      await logError({
        source: "set-image-backfill-tcgdex",
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

  return {
    total: targets.length,
    matched,
    filled,
    unmatched: unmatchedDetail.map((u) => u.name),
    unmatchedDetail,
  };
};

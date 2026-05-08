// src/services/tcgdexCardFill.service.ts
// Used to fill in cards that pokemontcg.io doesn't have yet.
// TCGdex often has complete set data before pokemontcg.io does.

import { supabaseAdmin } from "../lib/supabase";
import { tcgdexClient } from "../lib/tcgdexClient";

// ─── Rarity mapping from TCGdex → our standard labels ─────────────────────────

const RARITY_MAP: Record<string, string> = {
  // TCGdex English labels
  Common: "Common",
  Uncommon: "Uncommon",
  Rare: "Rare",
  "Rare Holo": "Rare Holo",
  "Double Rare": "Double Rare",
  "Ultra Rare": "Ultra Rare",
  "Illustration Rare": "Illustration Rare",
  "Special Illustration Rare": "Special Illustration Rare",
  "Hyper Rare": "Hyper Rare",
  "Rare BREAK": "Rare BREAK",
  "Rare Holo EX": "Rare Holo",
  "Rare Holo GX": "Rare Holo",
  "Rare Holo V": "Rare Holo V",
  "Rare Holo VMAX": "Rare Holo VMAX",
  "Rare Holo VSTAR": "Rare Holo VSTAR",
  "Rare Ultra": "Rare Ultra",
  "Rare Rainbow": "Rare Rainbow",
  "Rare Secret": "Rare Secret",
  Promo: "Promo",
  // TCGdex may use these alternate names
  "Amazing Rare": "Rare",
  "Trainer Gallery Rare Holo": "Trainer Gallery Rare Holo",
  "Radiant Rare": "Rare",
};

// ─── Result types ─────────────────────────────────────────────────────────────

export interface FillResult {
  setId: string;
  setName: string;
  tcgdexCards: number;
  dbCardsBefore: number;
  inserted: number;
  skipped: number;
  status: "complete" | "partial" | "no_tcgdex_data" | "error";
  notes: string[];
}

// ─── Fill a single set ─────────────────────────────────────────────────────────

export const fillMissingCardsFromTCGdex = async (
  setId: string,
  setName: string,
): Promise<FillResult> => {
  const result: FillResult = {
    setId,
    setName,
    tcgdexCards: 0,
    dbCardsBefore: 0,
    inserted: 0,
    skipped: 0,
    status: "no_tcgdex_data",
    notes: [],
  };

  // Get current DB card IDs for this set
  const { data: existingCards, count: dbCount } = await supabaseAdmin
    .from("cards")
    .select("id", { count: "exact" })
    .eq("set_id", setId);

  result.dbCardsBefore = dbCount ?? 0;
  const existingIds = new Set((existingCards ?? []).map((c) => c.id));

  // Fetch full card list from TCGdex
  const tcgCards = await tcgdexClient.getSetCards(setId);

  if (!tcgCards.length) {
    result.notes.push("TCGdex returned no cards for this set");
    return result;
  }

  result.tcgdexCards = tcgCards.length;
  result.status = "partial";

  // Determine which cards are missing from DB
  // TCGdex uses IDs like "sv01-001", our DB uses "sv1-001"
  // We need to normalize to match
  const normalizeId = (id: string) =>
    id.replace(/^([a-z]+)0(\d[a-z0-9]*)(-)/i, "$1$2$3");

  const missingCards = tcgCards.filter((c) => {
    const normalizedId = normalizeId(c.id);
    return !existingIds.has(c.id) && !existingIds.has(normalizedId);
  });

  if (!missingCards.length) {
    result.status = "complete";
    result.notes.push("No missing cards — DB already has all TCGdex cards");
    return result;
  }

  console.log(
    `[TCGdexFill] ${setName}: ${result.dbCardsBefore} in DB, ` +
      `${tcgCards.length} in TCGdex, ${missingCards.length} missing`,
  );

  // Get the set info from DB for set_id reference
  const { data: setData } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .eq("id", setId)
    .single();

  if (!setData) {
    result.status = "error";
    result.notes.push("Set not found in DB");
    return result;
  }

  // Build rows for missing cards
  // Use normalized ID (sv1-001 format) to match pokemontcg.io
  const rows = missingCards.map((card) => {
    const normalizedId = normalizeId(card.id);
    const rarity = card.rarity
      ? (RARITY_MAP[card.rarity] ?? card.rarity)
      : null;

    // Build TCGdex image URL → convert to usable image URL
    // TCGdex images: https://assets.tcgdex.net/en/sv/sv01/001/high.png
    // We store small + large
    const imageBase = card.image ?? null;
    const imageSmall = imageBase ? `${imageBase}/low.png` : null;
    const imageLarge = imageBase ? `${imageBase}/high.png` : null;

    return {
      id: normalizedId,
      name: card.name,
      number: card.localId,
      supertype: null, // TCGdex brief doesn't include this
      subtypes: [],
      hp: null,
      types: [],
      rarity,
      set_id: setId,
      image_small: imageSmall,
      image_large: imageLarge,
      tcgplayer_url: null,
      cardmarket_url: null,
      synced_at: new Date().toISOString(),
    };
  });

  // Insert in batches
  const CHUNK = 100;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error } = await supabaseAdmin
      .from("cards")
      .upsert(chunk, { onConflict: "id" });

    if (error) {
      console.error(`[TCGdexFill] Insert error for ${setId}:`, error.message);
      result.notes.push(`Insert error at batch ${i}: ${error.message}`);
      result.status = "error";
      return result;
    }

    result.inserted += chunk.length;
  }

  result.skipped = tcgCards.length - missingCards.length;
  result.status = "complete";

  console.log(
    `[TCGdexFill] ✓ ${setName}: inserted ${result.inserted} missing cards`,
  );

  return result;
};

// ─── Fill all sets that are below their expected total ────────────────────────

export const fillAllSetsFromTCGdex = async (): Promise<{
  total: number;
  filled: number;
  alreadyComplete: number;
  noTCGdexData: number;
  errors: number;
  results: FillResult[];
}> => {
  console.log("[TCGdexFill] Starting fill for all sets...");

  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name, total, printed_total")
    .order("release_date", { ascending: false });

  if (!sets?.length) {
    return {
      total: 0,
      filled: 0,
      alreadyComplete: 0,
      noTCGdexData: 0,
      errors: 0,
      results: [],
    };
  }

  // Only process sets where DB count < expected total
  const summary = {
    total: sets.length,
    filled: 0,
    alreadyComplete: 0,
    noTCGdexData: 0,
    errors: 0,
  };
  const results: FillResult[] = [];

  for (const set of sets) {
    const expected = set.total ?? set.printed_total ?? 0;

    const { count: dbCount } = await supabaseAdmin
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("set_id", set.id);

    const actual = dbCount ?? 0;

    // Skip if DB already meets or exceeds expected total
    if (expected > 0 && actual >= expected) {
      summary.alreadyComplete++;
      continue;
    }

    const result = await fillMissingCardsFromTCGdex(set.id, set.name);
    results.push(result);

    if (result.status === "complete" && result.inserted > 0) summary.filled++;
    else if (result.status === "no_tcgdex_data") summary.noTCGdexData++;
    else if (result.status === "error") summary.errors++;
    else summary.alreadyComplete++;

    // Polite delay
    await new Promise((r) => setTimeout(r, 400));
  }

  console.log(
    `[TCGdexFill] Complete — filled: ${summary.filled}, ` +
      `already complete: ${summary.alreadyComplete}, ` +
      `no TCGdex data: ${summary.noTCGdexData}, errors: ${summary.errors}`,
  );

  return { ...summary, results };
};

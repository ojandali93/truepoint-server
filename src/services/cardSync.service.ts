import { pokemonTcgClient } from "../lib/pokemonTcgClient";
import { supabaseAdmin } from "../lib/supabase";
import { findAllSets } from "../repositories/card.repository";

interface SyncProgress {
  totalSets: number;
  completedSets: number;
  totalCards: number;
  failedSets: string[];
  durationMs: number;
}

// Upsert a batch of cards for one set
const upsertCardBatch = async (cards: any[]): Promise<void> => {
  const rows = cards.map((c) => ({
    id: c.id,
    name: c.name,
    number: c.number,
    supertype: c.supertype ?? null,
    subtypes: c.subtypes ?? [],
    hp: c.hp ?? null,
    types: c.types ?? [],
    rarity: c.rarity ?? null,
    set_id: c.set.id,
    image_small: c.images?.small ?? null,
    image_large: c.images?.large ?? null,
    tcgplayer_url: c.tcgplayer?.url ?? null,
    cardmarket_url: c.cardmarket?.url ?? null,
    synced_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from("cards")
    .upsert(rows, { onConflict: "id" });

  if (error) throw error;
};

// Check if a set's cards are already synced
const isSetSynced = async (setId: string): Promise<boolean> => {
  const { count, error } = await supabaseAdmin
    .from("cards")
    .select("id", { count: "exact", head: true })
    .eq("set_id", setId);

  if (error) return false;
  return (count ?? 0) > 0;
};

// Sync a single set — fetches all pages
const syncSet = async (setId: string, setName: string): Promise<number> => {
  let page = 1;
  let totalSynced = 0;

  while (true) {
    const result = await pokemonTcgClient.getCardsBySet(setId, page, 250);
    if (result.data.length === 0) break;

    await upsertCardBatch(result.data);
    totalSynced += result.data.length;

    console.log(`  [${setName}] Page ${page}: ${result.data.length} cards`);

    // No more pages
    if (result.data.length < 250) break;
    page++;

    // Polite delay between pages to avoid rate limiting
    await delay(300);
  }

  return totalSynced;
};

// Full backfill — syncs all sets that don't have cards yet
// Skips sets already in the DB so it's safe to re-run
export const backfillAllCards = async (): Promise<SyncProgress> => {
  const start = Date.now();
  const sets = await findAllSets();
  const failedSets: string[] = [];
  let totalCards = 0;
  let completedSets = 0;

  console.log(`[CardSync] Starting backfill for ${sets.length} sets...`);

  for (const set of sets) {
    const alreadySynced = await isSetSynced(set.id);
    if (alreadySynced) {
      console.log(`[CardSync] Skipping ${set.name} — already synced`);
      completedSets++;
      continue;
    }

    try {
      console.log(`[CardSync] Syncing ${set.name} (${set.id})...`);
      const count = await syncSet(set.id, set.name);
      totalCards += count;
      completedSets++;
      console.log(`[CardSync] ✓ ${set.name}: ${count} cards`);

      // Polite delay between sets
      await delay(500);
    } catch (err: any) {
      console.error(`[CardSync] ✗ Failed ${set.name}:`, err?.message);
      failedSets.push(set.id);
    }
  }

  const durationMs = Date.now() - start;
  console.log(
    `[CardSync] Backfill complete: ${totalCards} cards across ${completedSets} sets in ${(durationMs / 1000).toFixed(1)}s`,
  );

  return {
    totalSets: sets.length,
    completedSets,
    totalCards,
    failedSets,
    durationMs,
  };
};

// Sync a single set on demand (e.g. when a new set releases)
export const syncSingleSet = async (setId: string): Promise<number> => {
  const sets = await findAllSets();
  const set = sets.find((s: any) => s.id === setId);
  if (!set) throw { status: 404, message: `Set ${setId} not found` };
  return syncSet(setId, set.name);
};

// Get sync status — how many cards are in the DB
export const getSyncStatus = async (): Promise<{
  totalSets: number;
  syncedSets: number;
  totalCards: number;
}> => {
  const sets = await findAllSets();

  const { count: totalCards } = await supabaseAdmin
    .from("cards")
    .select("id", { count: "exact", head: true });

  const { data: syncedSetIds } = await supabaseAdmin
    .from("cards")
    .select("set_id")
    .limit(10000);

  const uniqueSets = new Set((syncedSetIds ?? []).map((r: any) => r.set_id));

  return {
    totalSets: sets.length,
    syncedSets: uniqueSets.size,
    totalCards: totalCards ?? 0,
  };
};

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

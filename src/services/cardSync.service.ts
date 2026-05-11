// src/services/cardSync.service.ts
// Key fix: isSetSynced now compares DB card count against the set's totalCards
// from the sets table so incomplete syncs are detected and re-run.

import { supabaseAdmin } from '../lib/supabase';
import { findAllSets } from '../repositories/card.repository';
import { pokemonTcgClient } from '../lib/pokemonTcgClient';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface SyncProgress {
  totalSets: number;
  completedSets: number;
  totalCards: number;
  failedSets: string[];
  skippedSets: string[];
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
    .from('cards')
    .upsert(rows, { onConflict: 'id' });

  if (error) throw error;
};

// ─── Fixed completeness check ─────────────────────────────────────────────────
// Previously: isSetSynced only checked count > 0 — missed partial syncs.
// Now: compares DB count against the set's printed_total from the sets table.
// If the set doesn't have a printed_total, falls back to count > 0.

const isSetComplete = async (setId: string): Promise<boolean> => {
  // Get expected card count from sets table
  const { data: set } = await supabaseAdmin
    .from('sets')
    .select('printed_total, total')
    .eq('id', setId)
    .single();

  const expected = set?.printed_total ?? set?.total ?? 0;

  // Get actual count in DB
  const { count } = await supabaseAdmin
    .from('cards')
    .select('id', { count: 'exact', head: true })
    .eq('set_id', setId);

  const actual = count ?? 0;

  if (expected === 0) {
    // No expected count available — just check if anything exists
    return actual > 0;
  }

  // Allow a small tolerance (secret rares, promos can push above printed_total)
  // Consider complete if we have >= 95% of expected cards
  const isComplete = actual >= Math.floor(expected * 0.95);

  if (!isComplete) {
    console.log(
      `[CardSync] ⚠️  ${setId}: ${actual}/${expected} cards — incomplete, will re-sync`
    );
  }

  return isComplete;
};

// Sync a single set — fetches all pages from pokemontcg.io API
const syncSet = async (setId: string, setName: string): Promise<number> => {
  let page = 1;
  let totalSynced = 0;

  while (true) {
    const result = await pokemonTcgClient.getCardsBySet(setId, page, 250);
    if (result.data.length === 0) break;

    await upsertCardBatch(result.data);
    totalSynced += result.data.length;

    console.log(`  [${setName}] Page ${page}: ${result.data.length} cards`);

    if (result.data.length < 250) break;
    page++;

    await delay(300);
  }

  return totalSynced;
};

// ─── Backfill — now re-syncs incomplete sets ──────────────────────────────────

export const backfillAllCards = async (): Promise<SyncProgress> => {
  const start = Date.now();
  const sets = await findAllSets();
  const failedSets: string[] = [];
  const skippedSets: string[] = [];
  let totalCards = 0;
  let completedSets = 0;

  console.log(`[CardSync] Starting backfill for ${sets.length} sets...`);

  for (const set of sets) {
    const complete = await isSetComplete(set.id);
    if (complete) {
      skippedSets.push(set.id);
      completedSets++;
      continue;
    }

    try {
      console.log(`[CardSync] Syncing ${set.name} (${set.id})...`);
      const count = await syncSet(set.id, set.name);
      totalCards += count;
      completedSets++;
      console.log(`[CardSync] ✓ ${set.name}: ${count} cards`);
      await delay(500);
    } catch (err: any) {
      console.error(`[CardSync] ✗ Failed ${set.name}:`, err?.message);
      failedSets.push(set.id);
    }
  }

  const durationMs = Date.now() - start;
  console.log(
    `[CardSync] Backfill complete: ${totalCards} new cards, ` +
    `${skippedSets.length} sets skipped (already complete), ` +
    `${failedSets.length} failed in ${(durationMs / 1000).toFixed(1)}s`
  );

  return {
    totalSets: sets.length,
    completedSets,
    totalCards,
    failedSets,
    skippedSets,
    durationMs,
  };
};

// Sync a single set by ID — always re-syncs regardless of current count
export const syncSingleSet = async (setId: string): Promise<number> => {
  const sets = await findAllSets();
  const set = sets.find((s: any) => s.id === setId);
  if (!set) throw { status: 404, message: `Set ${setId} not found` };

  console.log(`[CardSync] Force re-syncing ${set.name} (${setId})...`);
  const count = await syncSet(setId, set.name);
  console.log(`[CardSync] ✓ ${set.name}: ${count} cards synced`);
  return count;
};

// Get sync status with completeness info
export const getSyncStatus = async (): Promise<{
  totalSets: number;
  completeSets: number;
  incompleteSets: { id: string; name: string; dbCount: number; expected: number }[];
  totalCards: number;
}> => {
  const sets = await findAllSets();

  const { count: totalCards } = await supabaseAdmin
    .from('cards')
    .select('id', { count: 'exact', head: true });

  // Check each set for completeness
  const incompleteSets: { id: string; name: string; dbCount: number; expected: number }[] = [];

  for (const set of sets) {
    const { data: setData } = await supabaseAdmin
      .from('sets')
      .select('printed_total, total, name')
      .eq('id', set.id)
      .single();

    const expected = setData?.printed_total ?? setData?.total ?? 0;

    const { count: dbCount } = await supabaseAdmin
      .from('cards')
      .select('id', { count: 'exact', head: true })
      .eq('set_id', set.id);

    const actual = dbCount ?? 0;

    if (expected > 0 && actual < Math.floor(expected * 0.95)) {
      incompleteSets.push({
        id: set.id,
        name: setData?.name ?? set.id,
        dbCount: actual,
        expected,
      });
    }
  }

  return {
    totalSets: sets.length,
    completeSets: sets.length - incompleteSets.length,
    incompleteSets,
    totalCards: totalCards ?? 0,
  };
};

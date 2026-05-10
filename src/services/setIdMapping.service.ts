// src/services/setIdMapping.service.ts
// Fetches all sets from TCGdex and matches them to our sets table by name/ID.
// Stores the tcgdex_id so all future syncs can use the correct ID directly.

import { supabaseAdmin } from '../lib/supabase';
import { tcgdexClient } from '../lib/tcgdexClient';

interface TCGdexSetBrief {
  id: string;
  name: string;
  releaseDate?: string;
}

// ─── Normalize names for fuzzy matching ──────────────────────────────────────

const normalizeName = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')   // strip punctuation
    .replace(/\s+/g, ' ')
    .trim();

// ─── Build ID mapping: our set ID → TCGdex set ID ────────────────────────────

export const discoverTCGdexIds = async (): Promise<{
  matched: number;
  unmatched: string[];
  alreadyMapped: number;
}> => {
  console.log('[SetIdMapping] Fetching TCGdex set list...');

  // Get all sets from TCGdex
  const tcgdexSets = await tcgdexClient.getAllSets() as TCGdexSetBrief[];

  if (!tcgdexSets.length) {
    console.error('[SetIdMapping] TCGdex returned no sets');
    return { matched: 0, unmatched: [], alreadyMapped: 0 };
  }

  console.log(`[SetIdMapping] TCGdex has ${tcgdexSets.length} sets`);

  // Build lookup maps from TCGdex data
  const tcgdexById = new Map(tcgdexSets.map((s) => [s.id.toLowerCase(), s]));
  const tcgdexByName = new Map(tcgdexSets.map((s) => [normalizeName(s.name), s]));

  // Get all our sets that don't have a tcgdex_id yet
  const { data: ourSets } = await supabaseAdmin
    .from('sets')
    .select('id, name, tcgdex_id')
    .order('id');

  if (!ourSets?.length) return { matched: 0, unmatched: [], alreadyMapped: 0 };

  let matched = 0;
  let alreadyMapped = 0;
  const unmatched: string[] = [];

  for (const set of ourSets) {
    // Skip if already mapped
    if (set.tcgdex_id) {
      alreadyMapped++;
      continue;
    }

    // Strategy 1: direct ID match (our sv1 → their sv1 or sv01)
    const directMatch =
      tcgdexById.get(set.id.toLowerCase()) ??
      tcgdexById.get(set.id.toLowerCase().replace(/([a-z])(\d)([a-z]|pt|$)/i,
        (_match: string, p: string, d: string, s: string) => `${p}0${d}${s}`
      ).toLowerCase());

    if (directMatch) {
      await supabaseAdmin
        .from('sets')
        .update({ tcgdex_id: directMatch.id })
        .eq('id', set.id);
      console.log(`[SetIdMapping] ✓ ${set.name}: ${set.id} → ${directMatch.id} (ID match)`);
      matched++;
      continue;
    }

    // Strategy 2: name match
    const normalizedName = normalizeName(set.name);
    const nameMatch = tcgdexByName.get(normalizedName);

    if (nameMatch) {
      await supabaseAdmin
        .from('sets')
        .update({ tcgdex_id: nameMatch.id })
        .eq('id', set.id);
      console.log(`[SetIdMapping] ✓ ${set.name}: ${set.id} → ${nameMatch.id} (name match)`);
      matched++;
      continue;
    }

    // Strategy 3: partial name match (handles "Scarlet & Violet" vs "Scarlet and Violet")
    const partialMatch = Array.from(tcgdexByName.entries()).find(([tcgName]) => {
      return tcgName.includes(normalizedName.slice(0, 8)) ||
             normalizedName.includes(tcgName.slice(0, 8));
    });

    if (partialMatch) {
      const [, tcgSet] = partialMatch;
      await supabaseAdmin
        .from('sets')
        .update({ tcgdex_id: tcgSet.id })
        .eq('id', set.id);
      console.log(`[SetIdMapping] ~ ${set.name}: ${set.id} → ${tcgSet.id} (partial match)`);
      matched++;
      continue;
    }

    unmatched.push(`${set.name} (${set.id})`);
  }

  if (unmatched.length > 0) {
    console.warn(`[SetIdMapping] ${unmatched.length} sets could not be matched to TCGdex:`);
    unmatched.forEach((s) => console.warn(`  • ${s}`));
  }

  console.log(
    `[SetIdMapping] Done — matched: ${matched}, already mapped: ${alreadyMapped}, ` +
    `unmatched: ${unmatched.length}`
  );

  return { matched, unmatched, alreadyMapped };
};

// ─── Get TCGdex ID for a set (from DB, not guessing) ─────────────────────────

export const getTCGdexIdForSet = async (ourSetId: string): Promise<string | null> => {
  const { data } = await supabaseAdmin
    .from('sets')
    .select('tcgdex_id')
    .eq('id', ourSetId)
    .single();
  return data?.tcgdex_id ?? null;
};

// ─── Get all set ID mappings ───────────────────────────────────────────────────

export const getAllSetMappings = async () => {
  const { data } = await supabaseAdmin
    .from('sets')
    .select('id, name, tcgdex_id, tcgplayer_set_id, release_date')
    .order('release_date', { ascending: false });
  return data ?? [];
};

// src/services/variantSync.service.ts
import { supabaseAdmin } from '../lib/supabase';
import { tcgdexClient } from '../lib/tcgdexClient';
import {
  setVariantReady,
  upsertSetVariantRules,
} from '../repositories/variant.repository';

// ─── Variant colour/label palette ─────────────────────────────────────────────

const VARIANT_COLORS: Record<string, string> = {
  normal: '#6B7280',
  reverse_holo: '#A78BFA',
  holo: '#F59E0B',
  first_edition: '#10B981',
  pokeball_holo: '#EF4444',
  masterball_holo: '#8B5CF6',
  greatball_holo: '#3B82F6',
  ultraball_holo: '#F97316',
  energy_holo: '#06B6D4',
  cosmos_holo: '#EC4899',
  galaxy_holo: '#6366F1',
  starlight_holo: '#FBBF24',
  cracked_ice_holo: '#67E8F9',
  mirror_holo: '#C0C0C0',
  loveball_holo: '#FB7185',
  friendball_holo: '#4ADE80',
  quickball_holo: '#FDE68A',
  duskball_holo: '#7C3AED',
};

const VARIANT_LABELS: Record<string, string> = {
  normal: 'Normal',
  reverse_holo: 'Reverse Holo',
  holo: 'Holofoil',
  first_edition: '1st Edition',
  pokeball_holo: 'Poké Ball Holo',
  masterball_holo: 'Master Ball Holo',
  greatball_holo: 'Great Ball Holo',
  ultraball_holo: 'Ultra Ball Holo',
  energy_holo: 'Energy Holo',
  cosmos_holo: 'Cosmos Holo',
  galaxy_holo: 'Galaxy Holo',
  starlight_holo: 'Starlight Holo',
  cracked_ice_holo: 'Cracked Ice Holo',
  mirror_holo: 'Mirror Holo',
  loveball_holo: 'Love Ball Holo',
  friendball_holo: 'Friend Ball Holo',
  quickball_holo: 'Quick Ball Holo',
  duskball_holo: 'Dusk Ball Holo',
};

const FOIL_TO_VARIANT: Record<string, string> = {
  pokeball: 'pokeball_holo',
  masterball: 'masterball_holo',
  greatball: 'greatball_holo',
  ultraball: 'ultraball_holo',
  energy: 'energy_holo',
  cosmos: 'cosmos_holo',
  galaxy: 'galaxy_holo',
  starlight: 'starlight_holo',
  'cracked-ice': 'cracked_ice_holo',
  mirror: 'mirror_holo',
  loveball: 'loveball_holo',
  friendball: 'friendball_holo',
  quickball: 'quickball_holo',
  duskball: 'duskball_holo',
};

// ─── Variant row type ─────────────────────────────────────────────────────────

interface VariantRow {
  cardId: string;
  setId: string;
  variantType: string;
  label: string;
  color: string;
  sortOrder: number;
}

const makeVariant = (cardId: string, setId: string, type: string, order: number): VariantRow => ({
  cardId, setId,
  variantType: type,
  label: VARIANT_LABELS[type] ?? type,
  color: VARIANT_COLORS[type] ?? '#6B7280',
  sortOrder: order,
});

// ─── Build variants from TCGdex card data ────────────────────────────────────

const buildVariantsFromTCGdex = (
  cardId: string,
  setId: string,
  variants: any,
  foil: string | undefined,
  isDualBall: boolean,
  rarity: string,
  foilPatterns: string[]
): VariantRow[] => {
  const hasVariantData =
    variants !== null &&
    variants !== undefined &&
    typeof variants === 'object' &&
    ('normal' in variants || 'reverse' in variants || 'holo' in variants);

  if (!hasVariantData) {
    return buildFallbackVariants(cardId, setId, rarity, isDualBall, foilPatterns);
  }

  const rows: VariantRow[] = [];
  let order = 0;

  if (variants.normal) rows.push(makeVariant(cardId, setId, 'normal', order++));
  if (variants.firstEdition) rows.push(makeVariant(cardId, setId, 'first_edition', order++));
  if (variants.holo) rows.push(makeVariant(cardId, setId, 'holo', order++));

  if (variants.reverse) {
    const isCommonUncommon = rarity === 'Common' || rarity === 'Uncommon';
    if (isDualBall && isCommonUncommon) {
      foilPatterns.forEach((p) => rows.push(makeVariant(cardId, setId, p, order++)));
    } else if (foil && FOIL_TO_VARIANT[foil]) {
      rows.push(makeVariant(cardId, setId, FOIL_TO_VARIANT[foil], order++));
    } else {
      rows.push(makeVariant(cardId, setId, 'reverse_holo', order++));
    }
  }

  return rows;
};

// ─── Rarity-based fallback ────────────────────────────────────────────────────

const buildFallbackVariants = (
  cardId: string,
  setId: string,
  rarity: string,
  isDualBall: boolean,
  foilPatterns: string[]
): VariantRow[] => {
  const rows: VariantRow[] = [];
  let order = 0;

  const isCommonUncommon = rarity === 'Common' || rarity === 'Uncommon';
  const isHigher = rarity !== '' && !['Common', 'Uncommon', 'Rare', 'Rare Holo'].includes(rarity);

  rows.push(makeVariant(cardId, setId, 'normal', order++));

  if (isHigher) return rows;

  const hasReverseHolo =
    setId.startsWith('sv') ||
    setId.startsWith('swsh') ||
    setId.startsWith('sm') ||
    setId.startsWith('xy') ||
    setId.startsWith('bw') ||
    setId.startsWith('dp') ||
    setId.startsWith('ex') ||
    setId.startsWith('hgss') ||
    setId.startsWith('pl') ||
    setId.startsWith('pop') ||
    setId.startsWith('me');

  if (hasReverseHolo) {
    if (isDualBall && isCommonUncommon) {
      foilPatterns.forEach((p) => rows.push(makeVariant(cardId, setId, p, order++)));
    } else {
      rows.push(makeVariant(cardId, setId, 'reverse_holo', order++));
    }
  }

  if (rarity === 'Rare Holo') {
    rows.push(makeVariant(cardId, setId, 'holo', order++));
  }

  // Base Set era — first edition
  if (['base1', 'base2', 'base3', 'base4', 'base5', 'basep', 'gym1', 'gym2', 'neo1', 'neo2', 'neo3', 'neo4'].includes(setId)) {
    rows.push(makeVariant(cardId, setId, 'first_edition', order++));
  }

  return rows;
};

// ─── Dual-ball set detection ──────────────────────────────────────────────────

const DUAL_BALL_SETS = new Set(['sv8pt5', 'sv9', 'sv9pt5']);
const POKEBALL_ONLY_SETS = new Set(['sv3pt5', 'sv4pt5']);

const isDualBallEraSet = (setId: string) =>
  DUAL_BALL_SETS.has(setId) || POKEBALL_ONLY_SETS.has(setId);

const getDualBallPatterns = (setId: string): string[] => {
  if (DUAL_BALL_SETS.has(setId)) return ['reverse_holo', 'pokeball_holo', 'masterball_holo'];
  if (POKEBALL_ONLY_SETS.has(setId)) return ['reverse_holo', 'pokeball_holo'];
  return ['reverse_holo'];
};

// ─── Set-level rules seeding ──────────────────────────────────────────────────

const seedSetRules = async (setId: string): Promise<void> => {
  const foilPatterns = getDualBallPatterns(setId);

  const cu = [
    { type: 'normal', label: 'Normal', color: '#6B7280', sort_order: 0 },
    ...foilPatterns.map((p, i) => ({
      type: p, label: VARIANT_LABELS[p], color: VARIANT_COLORS[p], sort_order: i + 1,
    })),
  ];
  const rareRev = [
    { type: 'normal', label: 'Normal', color: '#6B7280', sort_order: 0 },
    { type: 'reverse_holo', label: 'Reverse Holo', color: '#A78BFA', sort_order: 1 },
  ];
  const holoRare = [
    { type: 'normal', label: 'Normal', color: '#6B7280', sort_order: 0 },
    { type: 'holo', label: 'Holofoil', color: '#F59E0B', sort_order: 1 },
    { type: 'reverse_holo', label: 'Reverse Holo', color: '#A78BFA', sort_order: 2 },
  ];
  const normalOnly = [{ type: 'normal', label: 'Normal', color: '#6B7280', sort_order: 0 }];

  const isSv = setId.startsWith('sv');
  const isSwsh = setId.startsWith('swsh');
  const isSm = setId.startsWith('sm');
  const isXy = setId.startsWith('xy');
  const isBw = setId.startsWith('bw');
  const hasModernReverseHolo = isSv || isSwsh || isSm || isXy || isBw;

  const rules: { rarity: string; variants: any[] }[] = [
    { rarity: 'Common', variants: cu },
    { rarity: 'Uncommon', variants: cu },
    { rarity: 'Rare', variants: hasModernReverseHolo ? rareRev : normalOnly },
    { rarity: 'Rare Holo', variants: holoRare },
    { rarity: 'Double Rare', variants: normalOnly },
    { rarity: 'Ultra Rare', variants: normalOnly },
    { rarity: 'Illustration Rare', variants: normalOnly },
    { rarity: 'Special Illustration Rare', variants: normalOnly },
    { rarity: 'Hyper Rare', variants: normalOnly },
    { rarity: 'Promo', variants: normalOnly },
  ];

  if (isSwsh) {
    rules.push(
      { rarity: 'Rare Holo V', variants: normalOnly },
      { rarity: 'Rare Holo VMAX', variants: normalOnly },
      { rarity: 'Rare Holo VSTAR', variants: normalOnly },
      { rarity: 'Rare Ultra', variants: normalOnly },
      { rarity: 'Rare Rainbow', variants: normalOnly },
      { rarity: 'Rare Secret', variants: normalOnly },
    );
  }

  await upsertSetVariantRules(setId, rules);
};

// ─── Diagnostic ───────────────────────────────────────────────────────────────

export const diagnoseTCGdexSet = async (setId: string) => {
  // Get brief cards first (no variant data)
  const idsToTry = [setId, ...tcgdexClient.getIdVariants(setId)];
  let briefCards: any[] = [];
  let resolvedId = setId;

  for (const id of idsToTry) {
    try {
      const axios = await import('axios');
      const res = await axios.default.get(`https://api.tcgdex.net/v2/en/sets/${id}`, { timeout: 10000 });
      if (res.data?.cards?.length) {
        briefCards = res.data.cards;
        resolvedId = id;
        break;
      }
    } catch { continue; }
  }

  // Fetch one full card to see variant structure
  const fullCard = briefCards[0] ? await tcgdexClient.getCard(briefCards[0].id) : null;

  const { data: dbCards } = await supabaseAdmin
    .from('cards')
    .select('id, rarity')
    .eq('set_id', setId)
    .limit(5);

  // Check ID matching using the ID map
  const idMap = tcgdexClient.buildIdMap(briefCards);
  const matchedCards = (dbCards ?? []).filter((c) => idMap.has(c.id)).length;

  return {
    setId,
    resolvedTCGdexId: resolvedId,
    tcgdexBriefCards: briefCards.length,
    sampleBriefCard: briefCards[0] ?? null,
    sampleFullCard: fullCard,
    fullCardHasVariants: !!fullCard?.variants,
    dbCards: dbCards?.length ?? 0,
    matchedCards,
    idMatchRate: `${matchedCards}/${dbCards?.length ?? 0} after ID normalization`,
    explanation: fullCard?.variants
      ? '✅ Full card endpoint has variant data — individual card fetching will work'
      : '⚠️ Even full card endpoint lacks variants — rarity rules will be used',
  };
};

// ─── Core sync function ───────────────────────────────────────────────────────

export interface SetSyncResult {
  setId: string;
  setName: string;
  status: 'synced' | 'partial' | 'not_found' | 'error';
  cardsProcessed: number;
  variantsSaved: number;
  tcgdexMatchedCards: number;
  fallbackCards: number;
  missingFoilData: boolean;
  notes: string[];
}

export const syncVariantsForSet = async (
  setId: string,
  setName: string
): Promise<SetSyncResult> => {
  const result: SetSyncResult = {
    setId, setName,
    status: 'not_found',
    cardsProcessed: 0,
    variantsSaved: 0,
    tcgdexMatchedCards: 0,
    fallbackCards: 0,
    missingFoilData: false,
    notes: [],
  };

  console.log(`[VariantSync] Fetching TCGdex data for: ${setName} (${setId})`);

  // getSetCards now fetches brief list first, then individual cards for variant data
  const tcgCards = await tcgdexClient.getSetCards(setId);

  if (!tcgCards.length) {
    result.notes.push('TCGdex returned no cards — using rarity rules');
    console.warn(`[VariantSync] No TCGdex data for ${setId} — using rarity rules`);

    // Still process with rarity rules if we have DB cards
    const { data: dbCards } = await supabaseAdmin
      .from('cards').select('id, rarity').eq('set_id', setId);

    if (!dbCards?.length) {
      await supabaseAdmin.from('set_variant_status').upsert(
        { set_id: setId, status: 'pending', variant_count: 0, last_updated: new Date().toISOString() },
        { onConflict: 'set_id' }
      );
      return result;
    }

    // Apply rarity rules
    const isDualBall = isDualBallEraSet(setId);
    const foilPatterns = getDualBallPatterns(setId);
    const allVariantRows: VariantRow[] = [];

    for (const dbCard of dbCards) {
      const rows = buildFallbackVariants(dbCard.id, setId, dbCard.rarity ?? '', isDualBall, foilPatterns);
      allVariantRows.push(...rows);
      result.cardsProcessed++;
      result.fallbackCards++;
    }

    await supabaseAdmin.from('card_variants').delete().eq('set_id', setId);
    if (allVariantRows.length) {
      await supabaseAdmin.from('card_variants').insert(
        allVariantRows.map((r) => ({ card_id: r.cardId, set_id: r.setId, variant_type: r.variantType, label: r.label, color: r.color, sort_order: r.sortOrder }))
      );
    }

    result.variantsSaved = allVariantRows.length;
    await seedSetRules(setId);
    await setVariantReady(setId, allVariantRows.length);
    result.status = 'partial';

    console.log(`[VariantSync] ✓ ${setName} (rarity rules): ${result.cardsProcessed} cards → ${result.variantsSaved} variants`);
    return result;
  }

  // Build ID map that handles sv01-001 ↔ sv1-001 normalization
  const tcgMap = tcgdexClient.buildIdMap(tcgCards);

  // Check if variant data is present
  const sampleCard = tcgCards[0];
  const tcgdexHasVariants =
    sampleCard?.variants !== undefined &&
    typeof sampleCard.variants === 'object' &&
    ('normal' in sampleCard.variants);

  if (!tcgdexHasVariants) {
    result.notes.push(`TCGdex cards lack variant field after full fetch — rarity rules used`);
    console.warn(`[VariantSync] ⚠️  ${setName}: TCGdex cards lack variant field — falling back to rarity rules`);
  }

  const { data: dbCards, error } = await supabaseAdmin
    .from('cards').select('id, rarity').eq('set_id', setId);

  if (error || !dbCards?.length) {
    result.status = 'error';
    result.notes.push('Could not fetch cards from database');
    return result;
  }

  const isDualBall = isDualBallEraSet(setId);
  const foilPatterns = getDualBallPatterns(setId);
  const allVariantRows: VariantRow[] = [];

  for (const dbCard of dbCards) {
    result.cardsProcessed++;
    const tcgCard = tcgMap.get(dbCard.id); // works for both sv1-001 and sv01-001

    const variantRows = buildVariantsFromTCGdex(
      dbCard.id, setId,
      tcgCard?.variants,
      tcgCard?.foil,
      isDualBall,
      dbCard.rarity ?? '',
      foilPatterns
    );

    allVariantRows.push(...variantRows);

    if (tcgCard && tcgdexHasVariants && tcgCard.variants) {
      result.tcgdexMatchedCards++;
    } else {
      result.fallbackCards++;
    }
  }

  // Delete and reinsert
  await supabaseAdmin.from('card_variants').delete().eq('set_id', setId);

  const CHUNK = 500;
  for (let i = 0; i < allVariantRows.length; i += CHUNK) {
    const chunk = allVariantRows.slice(i, i + CHUNK);
    const { error: insertErr } = await supabaseAdmin.from('card_variants').insert(
      chunk.map((r) => ({
        card_id: r.cardId, set_id: r.setId, variant_type: r.variantType,
        label: r.label, color: r.color, sort_order: r.sortOrder,
      }))
    );
    if (insertErr) {
      console.error(`[VariantSync] Insert error for ${setId}:`, insertErr.message);
      result.status = 'error';
      result.notes.push(`Insert error: ${insertErr.message}`);
      return result;
    }
  }

  result.variantsSaved = allVariantRows.length;
  await seedSetRules(setId);
  await setVariantReady(setId, allVariantRows.length);

  result.status = tcgdexHasVariants ? 'synced' : 'partial';

  const avg = result.variantsSaved / (result.cardsProcessed || 1);
  console.log(
    `[VariantSync] ✓ ${setName}: ${result.cardsProcessed} cards → ${result.variantsSaved} variants` +
    ` (avg ${avg.toFixed(1)}/card, ${result.tcgdexMatchedCards} from TCGdex, ${result.fallbackCards} from rules)`
  );

  return result;
};

// ─── Sync all sets ────────────────────────────────────────────────────────────

export interface AllSyncResult {
  total: number;
  synced: number;
  partial: number;
  notFound: number;
  errors: number;
  needsAttention: SetSyncResult[];
}

export const syncAllVariants = async (): Promise<AllSyncResult> => {
  console.log('[VariantSync] Starting full variant sync...');

  const { data: sets, error } = await supabaseAdmin
    .from('sets').select('id, name').order('release_date', { ascending: false });

  if (error || !sets?.length) {
    console.error('[VariantSync] Could not fetch sets:', error);
    return { total: 0, synced: 0, partial: 0, notFound: 0, errors: 0, needsAttention: [] };
  }

  const summary: AllSyncResult = {
    total: sets.length, synced: 0, partial: 0, notFound: 0, errors: 0, needsAttention: [],
  };

  for (const set of sets) {
    const result = await syncVariantsForSet(set.id, set.name);
    if (result.status === 'synced') summary.synced++;
    else if (result.status === 'partial') { summary.partial++; summary.needsAttention.push(result); }
    else if (result.status === 'not_found') { summary.notFound++; summary.needsAttention.push(result); }
    else { summary.errors++; summary.needsAttention.push(result); }

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`[VariantSync] Complete — synced: ${summary.synced}, partial: ${summary.partial}, not_found: ${summary.notFound}, errors: ${summary.errors}`);
  return summary;
};

// ─── Startup check ────────────────────────────────────────────────────────────

export const checkForNewSetsWithoutVariants = async (): Promise<string[]> => {
  const { data: allSets } = await supabaseAdmin.from('sets').select('id, name');
  const { data: readySets } = await supabaseAdmin
    .from('set_variant_status').select('set_id').eq('status', 'ready');

  const readyIds = new Set((readySets ?? []).map((r) => r.set_id));
  const pending = (allSets ?? []).filter((s) => !readyIds.has(s.id));

  const setsWithCards: string[] = [];
  for (const set of pending) {
    const { count } = await supabaseAdmin
      .from('cards').select('id', { count: 'exact', head: true }).eq('set_id', set.id);
    if ((count ?? 0) > 0) setsWithCards.push(set.name);
  }
  return setsWithCards;
};

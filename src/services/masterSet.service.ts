// src/services/masterSet.service.ts
// Master Set Tracking — 100% separate from inventory.
// Users manually check off cards they own in their physical binders.
// Plan limits: Free=1, Collector=3, Pro=unlimited (testing=unlimited)

import { supabaseAdmin } from '../lib/supabase';

// ─── Plan limits ──────────────────────────────────────────────────────────────
// Testing mode: everyone gets unlimited
const TESTING_MODE = true;

const PLAN_LIMITS: Record<string, number | null> = {
  free:      1,
  collector: 3,
  pro:       null, // unlimited
};

export const getUserPlan = async (userId: string): Promise<'free' | 'collector' | 'pro'> => {
  if (TESTING_MODE) return 'pro'; // unlimited during testing

  const { data } = await supabaseAdmin
    .from('subscriptions')
    .select('plan, status')
    .eq('user_id', userId)
    .single();

  if (!data || !['active', 'trialing'].includes(data.status)) return 'free';
  return data.plan as 'collector' | 'pro';
};

export const canTrackMoreSets = async (userId: string) => {
  const plan = await getUserPlan(userId);
  const limit = PLAN_LIMITS[plan];

  const { count } = await supabaseAdmin
    .from('master_set_tracking')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const current = count ?? 0;
  return {
    allowed: limit === null || current < limit,
    current,
    limit,
    plan,
  };
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MasterSetCard {
  cardId: string;
  name: string;
  number: string;
  rarity: string | null;
  imageSmall: string | null;
  imageLarge: string | null;
  artist: string | null;
  marketPrice: number | null;
  variants: {
    variantType: string;
    label: string;
    color: string;
    haveCount: number; // 0 = don't have, 1+ = have (dupes if > 1)
  }[];
  totalVariants: number;
  ownedVariants: number;
  duplicates: number; // any variant with qty > 1
}

export interface MasterSetProgress {
  setId: string;
  setName: string;
  seriesName: string | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  totalCards: number;
  totalVariants: number;
  ownedVariants: number;
  completionPct: number;
  needCount: number;
  dupeCount: number;
}

// ─── Get tracked sets ─────────────────────────────────────────────────────────

export const getTrackedSets = async (userId: string): Promise<MasterSetProgress[]> => {
  const { data: tracked } = await supabaseAdmin
    .from('master_set_tracking')
    .select('set_id')
    .eq('user_id', userId);

  if (!tracked?.length) return [];

  const results = await Promise.all(
    tracked.map((t) => getSetProgress(userId, t.set_id))
  );

  return results
    .filter(Boolean)
    .sort((a, b) => b!.completionPct - a!.completionPct) as MasterSetProgress[];
};

// ─── Get progress for one set ─────────────────────────────────────────────────

export const getSetProgress = async (
  userId: string,
  setId: string
): Promise<MasterSetProgress | null> => {
  const { data: set } = await supabaseAdmin
    .from('sets')
    .select('id, name, series, logo_url, symbol_url')
    .eq('id', setId)
    .single();

  if (!set) return null;

  const { data: cards } = await supabaseAdmin
    .from('cards')
    .select('id')
    .eq('set_id', setId);

  if (!cards?.length) return null;

  const { data: variants } = await supabaseAdmin
    .from('card_variants')
    .select('card_id, variant_type')
    .eq('set_id', setId);

  const totalVariants = variants?.length || cards.length;

  const { data: collected } = await supabaseAdmin
    .from('master_set_cards')
    .select('card_id, variant_type, quantity')
    .eq('user_id', userId)
    .eq('set_id', setId);

  const ownedSet = new Set((collected ?? []).map((c) => `${c.card_id}::${c.variant_type}`));
  const dupeCount = (collected ?? []).filter((c) => c.quantity > 1).length;
  const ownedVariants = ownedSet.size;

  return {
    setId: set.id,
    setName: set.name,
    seriesName: set.series,
    logoUrl: set.logo_url,
    symbolUrl: set.symbol_url,
    totalCards: cards.length,
    totalVariants,
    ownedVariants,
    completionPct: totalVariants > 0 ? Math.round((ownedVariants / totalVariants) * 100) : 0,
    needCount: totalVariants - ownedVariants,
    dupeCount,
  };
};

// ─── Get all cards for a set with collection status ───────────────────────────

export const getSetCards = async (
  userId: string,
  setId: string
): Promise<{ progress: MasterSetProgress | null; cards: MasterSetCard[] }> => {

  const progress = await getSetProgress(userId, setId);
  if (!progress) return { progress: null, cards: [] };

  // Get all cards
  const { data: rawCards } = await supabaseAdmin
    .from('cards')
    .select('id, name, number, rarity, image_small, image_large')
    .eq('set_id', setId);

  if (!rawCards?.length) return { progress, cards: [] };

  const cardIds = rawCards.map((c) => c.id);

  // Get variants
  const { data: variants } = await supabaseAdmin
    .from('card_variants')
    .select('card_id, variant_type, label, color, sort_order')
    .eq('set_id', setId)
    .order('sort_order');

  // Group variants by card
  const variantsByCard = new Map<string, typeof variants>();
  for (const v of variants ?? []) {
    if (!variantsByCard.has(v.card_id)) variantsByCard.set(v.card_id, []);
    variantsByCard.get(v.card_id)!.push(v);
  }

  // Get what user has collected
  const { data: collected } = await supabaseAdmin
    .from('master_set_cards')
    .select('card_id, variant_type, quantity')
    .eq('user_id', userId)
    .eq('set_id', setId);

  const collectedMap = new Map<string, number>();
  for (const c of collected ?? []) {
    collectedMap.set(`${c.card_id}::${c.variant_type}`, c.quantity);
  }

  // Get prices
  const { data: prices } = await supabaseAdmin
    .from('market_prices')
    .select('card_id, market_price')
    .in('card_id', cardIds)
    .eq('source', 'tcgplayer')
    .is('grade', null)
    .eq('variant', 'normal');

  const priceMap = new Map(prices?.map((p) => [p.card_id, p.market_price]) ?? []);

  // Build result
  const cards: MasterSetCard[] = rawCards.map((card) => {
    const cardVariants = variantsByCard.get(card.id) ?? [
      { card_id: card.id, variant_type: 'normal', label: 'Normal', color: '#E5C97E', sort_order: 0 }
    ];

    const variantData = cardVariants.map((v) => {
      const qty = collectedMap.get(`${card.id}::${v.variant_type}`) ?? 0;
      return {
        variantType: v.variant_type,
        label: v.label,
        color: v.color,
        haveCount: qty,
      };
    });

    const ownedVariants = variantData.filter((v) => v.haveCount > 0).length;
    const duplicates = variantData.filter((v) => v.haveCount > 1).length;

    return {
      cardId: card.id,
      name: card.name,
      number: card.number,
      rarity: card.rarity,
      imageSmall: card.image_small,
      imageLarge: card.image_large,
      artist: null,
      marketPrice: priceMap.get(card.id) ?? null,
      variants: variantData,
      totalVariants: variantData.length,
      ownedVariants,
      duplicates,
    };
  });

  // Sort by number (numeric)
  cards.sort((a, b) => {
    const na = parseInt(a.number) || 0;
    const nb = parseInt(b.number) || 0;
    return na - nb;
  });

  return { progress, cards };
};

// ─── Toggle card collected ────────────────────────────────────────────────────

export const toggleCard = async (
  userId: string,
  setId: string,
  cardId: string,
  variantType: string
): Promise<{ haveCount: number }> => {
  const { data: existing } = await supabaseAdmin
    .from('master_set_cards')
    .select('id, quantity')
    .eq('user_id', userId)
    .eq('set_id', setId)
    .eq('card_id', cardId)
    .eq('variant_type', variantType)
    .single();

  if (!existing) {
    // Mark as collected
    await supabaseAdmin.from('master_set_cards').insert({
      user_id: userId, set_id: setId, card_id: cardId,
      variant_type: variantType, quantity: 1,
    });
    return { haveCount: 1 };
  } else {
    // Remove
    await supabaseAdmin.from('master_set_cards').delete().eq('id', existing.id);
    return { haveCount: 0 };
  }
};

// ─── Increment/decrement quantity (for dupes) ─────────────────────────────────

export const updateCardQuantity = async (
  userId: string,
  setId: string,
  cardId: string,
  variantType: string,
  quantity: number
): Promise<void> => {
  if (quantity <= 0) {
    await supabaseAdmin.from('master_set_cards').delete()
      .eq('user_id', userId).eq('set_id', setId)
      .eq('card_id', cardId).eq('variant_type', variantType);
    return;
  }

  await supabaseAdmin.from('master_set_cards').upsert({
    user_id: userId, set_id: setId, card_id: cardId,
    variant_type: variantType, quantity,
  }, { onConflict: 'user_id,set_id,card_id,variant_type' });
};

// ─── Track / untrack a set ────────────────────────────────────────────────────

export const trackSet = async (userId: string, setId: string) => {
  const limit = await canTrackMoreSets(userId);
  if (!limit.allowed) {
    return { success: false, error: `Upgrade to track more sets. Current limit: ${limit.limit}` };
  }
  const { error } = await supabaseAdmin.from('master_set_tracking').upsert(
    { user_id: userId, set_id: setId },
    { onConflict: 'user_id,set_id', ignoreDuplicates: true },
  );

  return error ? { success: false, error: error.message } : { success: true };
};

export const untrackSet = async (userId: string, setId: string): Promise<void> => {
  await supabaseAdmin.from('master_set_tracking').delete()
    .eq('user_id', userId).eq('set_id', setId);
};

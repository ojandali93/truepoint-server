// src/services/pricing.service.ts
// Reads prices from market_prices table and resolves values for inventory/portfolio.
// Prices are populated by cardMarketPriceSync.service.ts via the bulk sync.
// No external API calls here — this is purely a DB reader.

import { supabaseAdmin } from '../lib/supabase';
import { TTLCache, TTL } from '../lib/cache';
import type { NormalizedPrice } from '../types/pokemon.types';

const memCache = new TTLCache<NormalizedPrice[]>();

// ─── Read from DB ─────────────────────────────────────────────────────────────

export const findCachedPrices = async (
  cardId: string,
  source?: string,
): Promise<NormalizedPrice[]> => {
  let q = supabaseAdmin
    .from('market_prices')
    .select('*')
    .eq('card_id', cardId)
    .gt('expires_at', new Date().toISOString());

  if (source) q = q.eq('source', source);

  const { data, error } = await q;
  if (error) {
    console.error('[PricingService] findCachedPrices error:', error.message);
    return [];
  }

  return (data ?? []).map((row: any) => ({
    cardId: row.card_id,
    source: row.source,
    variant: row.variant,
    grade: row.grade,
    lowPrice: row.low_price,
    midPrice: row.mid_price,
    highPrice: row.high_price,
    marketPrice: row.market_price,
    fetchedAt: row.fetched_at,
  }));
};

// ─── Get all prices for a card (read from cache only) ─────────────────────────
// Prices come from the bulk CardMarket sync, not fetched on-demand.

export const getAllPricesForCard = async (
  cardId: string,
): Promise<{
  tcgplayer: NormalizedPrice[];
  cardmarket: NormalizedPrice[];
  ebay: NormalizedPrice[];
}> => {
  const memKey = `prices:${cardId}`;
  const memHit = memCache.get(memKey);
  if (memHit) {
    return {
      tcgplayer: memHit.filter((p) => p.source === 'tcgplayer'),
      cardmarket: memHit.filter((p) => p.source === 'cardmarket'),
      ebay: memHit.filter((p) => p.source === 'ebay'),
    };
  }

  const cached = await findCachedPrices(cardId);
  if (cached.length > 0) {
    memCache.set(memKey, cached, TTL.PRICES_RAW);
  }

  return {
    tcgplayer: cached.filter((p) => p.source === 'tcgplayer'),
    cardmarket: cached.filter((p) => p.source === 'cardmarket'),
    ebay: cached.filter((p) => p.source === 'ebay'),
  };
};

// ─── Resolve single best price for a card ────────────────────────────────────
// For raw cards: TCGPlayer normal → CardMarket
// For graded cards: match by company + grade

export const resolveMarketValue = async (
  cardId: string,
  gradingCompany?: string | null,
  grade?: string | null,
): Promise<{ price: number | null; source: string | null }> => {
  const cached = await findCachedPrices(cardId);

  if (!cached.length) return { price: null, source: null };

  if (gradingCompany && grade) {
    const gradeLabel = `${gradingCompany.toUpperCase()} ${grade}`;
    const graded = cached.find(
      (p) => p.grade?.toLowerCase() === gradeLabel.toLowerCase() && p.marketPrice,
    );
    if (graded?.marketPrice) return { price: graded.marketPrice, source: graded.source };

    // Fallback to raw price if no graded price found
    const raw = cached.find((p) => !p.grade && p.source === 'tcgplayer' && p.marketPrice);
    if (raw?.marketPrice) return { price: raw.marketPrice, source: 'tcgplayer (raw fallback)' };
  } else {
    // TCGPlayer normal variant
    const normal = cached.find(
      (p) => p.source === 'tcgplayer' && !p.grade &&
        (p.variant === 'normal' || p.variant === 'unlimited') && p.marketPrice,
    );
    if (normal?.marketPrice) return { price: normal.marketPrice, source: 'tcgplayer' };

    // Any TCGPlayer raw price
    const anyTcg = cached.find(
      (p) => p.source === 'tcgplayer' && !p.grade && p.marketPrice,
    );
    if (anyTcg?.marketPrice) return { price: anyTcg.marketPrice, source: 'tcgplayer' };

    // CardMarket fallback
    const cm = cached.find(
      (p) => p.source === 'cardmarket' && !p.grade && p.marketPrice,
    );
    if (cm?.marketPrice) return { price: cm.marketPrice, source: 'cardmarket' };
  }

  return { price: null, source: null };
};

// ─── Batch resolve for inventory/portfolio (single DB query) ──────────────────

export const batchResolveMarketValues = async (
  cardIds: string[],
): Promise<Map<string, number | null>> => {
  if (!cardIds.length) return new Map();

  const { data } = await supabaseAdmin
    .from('market_prices')
    .select('card_id, source, variant, grade, market_price')
    .in('card_id', cardIds)
    .is('grade', null)
    .gt('expires_at', new Date().toISOString());

  const priceMap = new Map<string, number | null>();

  // TCGPlayer first
  for (const row of data ?? []) {
    if (!priceMap.has(row.card_id) && row.source === 'tcgplayer' && row.market_price) {
      priceMap.set(row.card_id, row.market_price);
    }
  }

  // CardMarket fallback for anything still missing
  for (const row of data ?? []) {
    if (!priceMap.has(row.card_id) && row.source === 'cardmarket' && row.market_price) {
      priceMap.set(row.card_id, row.market_price);
    }
  }

  // Null for cards with no price at all
  for (const id of cardIds) {
    if (!priceMap.has(id)) priceMap.set(id, null);
  }

  return priceMap;
};

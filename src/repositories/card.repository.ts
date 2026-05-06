import { supabase, supabaseAdmin } from '../lib/supabase';
import type { NormalizedPrice, PokemonSet } from '../types/pokemon.types';

const PRICE_TABLE = 'cached_card_prices';
const SET_TABLE = 'pokemon_sets';

// ─── Price Cache ──────────────────────────────────────────────────────────────

type CachedRow = {
  card_id: string;
  source: NormalizedPrice['source'];
  variant: string | null;
  grade: string | null;
  low_price: number | null;
  mid_price: number | null;
  high_price: number | null;
  market_price: number | null;
  fetched_at: string;
  expires_at: string;
};

const rowToNormalized = (row: CachedRow): NormalizedPrice => ({
  cardId: row.card_id,
  source: row.source,
  variant: row.variant,
  grade: row.grade,
  lowPrice: row.low_price,
  midPrice: row.mid_price,
  highPrice: row.high_price,
  marketPrice: row.market_price,
  fetchedAt: row.fetched_at,
});

export const findCachedPrices = async (
  cardId: string,
  source?: NormalizedPrice['source']
): Promise<NormalizedPrice[]> => {
  let q = supabaseAdmin
    .from(PRICE_TABLE)
    .select('*')
    .eq('card_id', cardId)
    .gt('expires_at', new Date().toISOString());

  if (source) q = q.eq('source', source);

  const { data, error } = await q;
  if (error) throw error;
  return ((data ?? []) as CachedRow[]).map(rowToNormalized);
};

export const upsertPrices = async (
  prices: NormalizedPrice[],
  ttlMs: number
): Promise<void> => {
  if (prices.length === 0) return;

  const cardId = prices[0].cardId;
  const sources = [...new Set(prices.map((p) => p.source))];

  const { error: deleteError } = await supabaseAdmin
    .from(PRICE_TABLE)
    .delete()
    .eq('card_id', cardId)
    .in('source', sources);

  if (deleteError) throw deleteError;

  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const rows = prices.map((p) => ({
    card_id: p.cardId,
    source: p.source,
    variant: p.variant,
    grade: p.grade,
    low_price: p.lowPrice,
    mid_price: p.midPrice,
    high_price: p.highPrice,
    market_price: p.marketPrice,
    fetched_at: p.fetchedAt,
    expires_at: expiresAt,
  }));

  const { error: insertError } = await supabaseAdmin.from(PRICE_TABLE).insert(rows);
  if (insertError) throw insertError;
};

export const purgeExpiredPrices = async (): Promise<void> => {
  const { error } = await supabaseAdmin
    .from(PRICE_TABLE)
    .delete()
    .lt('expires_at', new Date().toISOString());
  if (error) throw error;
};

// ─── Sets ─────────────────────────────────────────────────────────────────────

export const findAllSets = async () => {
  const { data, error } = await supabase
    .from(SET_TABLE)
    .select('*')
    .order('release_date', { ascending: false });
  if (error) throw error;
  return data ?? [];
};

export const findSetById = async (setId: string) => {
  const { data, error } = await supabase
    .from(SET_TABLE)
    .select('*')
    .eq('id', setId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const getLastSyncTime = async (): Promise<Date | null> => {
  const { data, error } = await supabase
    .from(SET_TABLE)
    .select('synced_at')
    .order('synced_at', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data ? new Date(data.synced_at) : null;
};

export const upsertSets = async (sets: PokemonSet[]): Promise<void> => {
  const rows = sets.map((s) => ({
    id: s.id,
    name: s.name,
    series: s.series,
    printed_total: s.printedTotal,
    total: s.total,
    release_date: s.releaseDate,
    symbol_url: s.images.symbol,
    logo_url: s.images.logo,
    synced_at: new Date().toISOString(),
  }));

  const { error } = await supabaseAdmin
    .from(SET_TABLE)
    .upsert(rows, { onConflict: 'id' });
  if (error) throw error;
};

// src/services/tcgapisSync.service.ts
// Replaces pokemontcgPriceSync, cardMarketPriceSync, variantSync, setIdMapping, tcgdexCardFill
// Single function syncs cards + variants + prices from TCGAPIs.com

import { supabaseAdmin } from '../lib/supabase';
import { tcgapisGet, POKEMON_CATEGORY_ID, resolveVariant, sleep } from '../lib/tcgapisClient';

// ─── Types ────────────────────────────────────────────────────────────────────

interface TCGExpansion {
  groupId: number;
  name: string;
  abbreviation?: string;
  publishedOn?: string;
}

interface TCGCard {
  productId: number;
  name: string;
  cleanName: string;
  image?: string;
  rarity?: string;
  number?: string;
}

interface TCGPriceData {
  lowPrice?: number | null;
  midPrice?: number | null;
  highPrice?: number | null;
  marketPrice?: number | null;
  directLowPrice?: number | null;
}

interface TCGPricesResponse {
  success: boolean;
  data?: {
    productId: number;
    prices?: Record<string, TCGPriceData>;
  };
}

interface TCGCardsResponse {
  success: boolean;
  count: number;
  total: number;
  data: TCGCard[];
}

interface TCGExpansionsResponse {
  success: boolean;
  count: number;
  total: number;
  data: TCGExpansion[];
}

// ─── Step 1: Map TCGAPIs groupIds to our sets ─────────────────────────────────

export const syncSetGroupIds = async (): Promise<{
  mapped: number;
  unmatched: string[];
}> => {
  console.log('[TCGAPIs] Fetching Pokemon expansions...');
  const allExpansions: TCGExpansion[] = [];
  let offset = 0;

  while (true) {
    await sleep(250);
    const data = await tcgapisGet<TCGExpansionsResponse>(
      `/api/v2/expansions/${POKEMON_CATEGORY_ID}`,
      { limit: 100, offset }
    );
    allExpansions.push(...(data.data ?? []));
    if (allExpansions.length >= data.total || (data.data?.length ?? 0) < 100) break;
    offset += 100;
  }

  console.log(`[TCGAPIs] Got ${allExpansions.length} expansions`);

  const { data: ourSets } = await supabaseAdmin
    .from('sets')
    .select('id, name, tcgapis_group_id');

  const normalize = (s: string) =>
    s.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();

  let mapped = 0;
  const unmatched: string[] = [];

  for (const exp of allExpansions) {
    const normExp = normalize(exp.name);
    const match = ourSets?.find(
      (s) => normalize(s.name) === normExp ||
             s.name.toLowerCase().trim() === exp.name.toLowerCase().trim()
    );

    if (match) {
      if (match.tcgapis_group_id !== exp.groupId) {
        await supabaseAdmin
          .from('sets')
          .update({ tcgapis_group_id: exp.groupId })
          .eq('id', match.id);
      }
      mapped++;
    } else {
      unmatched.push(exp.name);
    }
  }

  console.log(`[TCGAPIs] Mapped: ${mapped}, Unmatched: ${unmatched.length}`);
  if (unmatched.length > 0) {
    console.log('[TCGAPIs] Unmatched (first 10):', unmatched.slice(0, 10).join(', '));
  }

  return { mapped, unmatched };
};

// ─── Step 2: Sync cards + variants + prices for one set ──────────────────────

export const syncSetCards = async (setId: string): Promise<{
  cards: number; variants: number; prices: number; skipped: number;
}> => {
  const { data: set } = await supabaseAdmin
    .from('sets')
    .select('id, name, tcgapis_group_id')
    .eq('id', setId)
    .single();

  if (!set?.tcgapis_group_id) {
    console.log(`[TCGAPIs] ${setId} — no groupId, skipping`);
    return { cards: 0, variants: 0, prices: 0, skipped: 1 };
  }

  console.log(`[TCGAPIs] Syncing ${set.name} (groupId: ${set.tcgapis_group_id})`);

  // Fetch all cards for this set (paginated)
  const allApiCards: TCGCard[] = [];
  let offset = 0;

  while (true) {
    await sleep(250);
    const data = await tcgapisGet<TCGCardsResponse>(
      `/api/v2/cards/${set.tcgapis_group_id}`,
      { limit: 100, offset }
    );
    allApiCards.push(...(data.data ?? []));
    if (allApiCards.length >= data.total || (data.data?.length ?? 0) < 100) break;
    offset += 100;
  }

  // Get our DB cards
  const { data: ourCards } = await supabaseAdmin
    .from('cards')
    .select('id, number, name, tcgapis_product_id')
    .eq('set_id', setId);

  // Build lookup maps — try matching by number and by name
  const byNumber = new Map<string, any>();
  const byName = new Map<string, any>();
  for (const c of ourCards ?? []) {
    if (c.number) {
      byNumber.set(c.number, c);
      byNumber.set((c.number ?? '').replace(/^0+/, ''), c);
    }
    byName.set(c.name.toLowerCase().trim(), c);
  }

  let cardsUpdated = 0;
  let variantsUpserted = 0;
  let pricesUpserted = 0;
  let skipped = 0;

  for (const apiCard of allApiCards) {
    const numStripped = (apiCard.number ?? '').replace(/^0+/, '');
    const ourCard =
      byNumber.get(apiCard.number ?? '') ??
      byNumber.get(numStripped) ??
      byName.get(apiCard.name.toLowerCase().trim()) ??
      byName.get((apiCard.cleanName ?? '').toLowerCase().trim());

    if (!ourCard) { skipped++; continue; }

    // Update productId if needed
    if (ourCard.tcgapis_product_id !== apiCard.productId) {
      await supabaseAdmin
        .from('cards')
        .update({ tcgapis_product_id: apiCard.productId })
        .eq('id', ourCard.id);
      cardsUpdated++;
    }

    // Fetch prices (includes variant breakdown)
    await sleep(120);
    try {
      const priceRes = await tcgapisGet<TCGPricesResponse>(
        `/api/v2/prices/${apiCard.productId}`
      );

      const pricesObj = priceRes.data?.prices ?? {};
      const variantKeys = Object.keys(pricesObj);
      if (variantKeys.length === 0) { skipped++; continue; }

      for (const variantName of variantKeys) {
        const prices = pricesObj[variantName];
        if (!prices) continue;

        const variantDef = resolveVariant(variantName);

        // Upsert card_variant
        await supabaseAdmin
          .from('card_variants')
          .upsert({
            card_id:      ourCard.id,
            set_id:       setId,
            variant_type: variantDef.type,
            label:        variantDef.label,
            color:        variantDef.color,
            sort_order:   variantDef.sortOrder,
          }, { onConflict: 'card_id,variant_type' });

        variantsUpserted++;

        // Upsert market price
        if (prices.marketPrice == null && prices.lowPrice == null) continue;

        await supabaseAdmin
          .from('market_prices')
          .upsert({
            card_id:      ourCard.id,
            source:       'tcgplayer',
            variant:      variantDef.type,
            grade:        null,
            low_price:    prices.lowPrice ?? null,
            mid_price:    prices.midPrice ?? null,
            high_price:   prices.highPrice ?? null,
            market_price: prices.marketPrice ?? null,
            fetched_at:   new Date().toISOString(),
            expires_at:   new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
          }, { onConflict: 'card_id,source,variant,grade' });

        pricesUpserted++;
      }
    } catch (err: any) {
      console.error(`[TCGAPIs] Price fetch failed for ${apiCard.productId}:`, err?.message);
      skipped++;
    }
  }

  console.log(
    `[TCGAPIs] ${set.name} — cards: ${cardsUpdated}, variants: ${variantsUpserted}, ` +
    `prices: ${pricesUpserted}, skipped: ${skipped}`
  );
  return { cards: cardsUpdated, variants: variantsUpserted, prices: pricesUpserted, skipped };
};

// ─── Price-only refresh (daily cron — faster than full sync) ─────────────────

export const refreshPricesForSet = async (setId: string): Promise<{ prices: number }> => {
  const { data: cards } = await supabaseAdmin
    .from('cards')
    .select('id, tcgapis_product_id')
    .eq('set_id', setId)
    .not('tcgapis_product_id', 'is', null);

  let prices = 0;

  for (const card of cards ?? []) {
    await sleep(120);
    try {
      const priceRes = await tcgapisGet<TCGPricesResponse>(
        `/api/v2/prices/${card.tcgapis_product_id}`
      );

      const pricesObj = priceRes.data?.prices ?? {};
      for (const [variantName, priceData] of Object.entries(pricesObj)) {
        if (!priceData || (priceData.marketPrice == null && priceData.lowPrice == null)) continue;
        const variantDef = resolveVariant(variantName);

        await supabaseAdmin.from('market_prices').upsert({
          card_id:      card.id,
          source:       'tcgplayer',
          variant:      variantDef.type,
          grade:        null,
          low_price:    priceData.lowPrice ?? null,
          mid_price:    priceData.midPrice ?? null,
          high_price:   priceData.highPrice ?? null,
          market_price: priceData.marketPrice ?? null,
          fetched_at:   new Date().toISOString(),
          expires_at:   new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
        }, { onConflict: 'card_id,source,variant,grade' });

        prices++;
      }
    } catch {}
  }

  return { prices };
};

// ─── Full sync (weekly cron) ──────────────────────────────────────────────────

export const syncAllSets = async (): Promise<{
  setsProcessed: number; totalVariants: number; totalPrices: number;
}> => {
  console.log('[TCGAPIs] Starting full sync...');

  await syncSetGroupIds();
  await sleep(2000);

  const { data: sets } = await supabaseAdmin
    .from('sets')
    .select('id, name')
    .not('tcgapis_group_id', 'is', null)
    .order('release_date', { ascending: false });

  let setsProcessed = 0;
  let totalVariants = 0;
  let totalPrices = 0;

  for (const set of sets ?? []) {
    try {
      const result = await syncSetCards(set.id);
      totalVariants += result.variants;
      totalPrices += result.prices;
      setsProcessed++;
      await sleep(500);
    } catch (err: any) {
      console.error(`[TCGAPIs] Failed set ${set.name}:`, err?.message);
    }
  }

  console.log(
    `[TCGAPIs] Full sync done — sets: ${setsProcessed}, ` +
    `variants: ${totalVariants}, prices: ${totalPrices}`
  );
  return { setsProcessed, totalVariants, totalPrices };
};

// ─── Daily price refresh (all sets) ──────────────────────────────────────────

export const refreshAllPrices = async (): Promise<{ totalPrices: number }> => {
  console.log('[TCGAPIs] Starting daily price refresh...');

  const { data: sets } = await supabaseAdmin
    .from('sets')
    .select('id, name')
    .not('tcgapis_group_id', 'is', null)
    .order('release_date', { ascending: false });

  let totalPrices = 0;

  for (const set of sets ?? []) {
    try {
      const result = await refreshPricesForSet(set.id);
      totalPrices += result.prices;
      await sleep(300);
    } catch (err: any) {
      console.error(`[TCGAPIs] Price refresh failed for ${set.name}:`, err?.message);
    }
  }

  console.log(`[TCGAPIs] Price refresh done — ${totalPrices} prices updated`);
  return { totalPrices };
};

// ─── Sales history for a card ─────────────────────────────────────────────────

export const getCardSalesHistory = async (
  productId: number,
  variant?: string,
  limit = 50
) => {
  const params: Record<string, any> = {
    condition: 'Near Mint',
    language: 'English',
    salesOnly: true,
    limit,
  };
  if (variant) params.variant = variant;

  return tcgapisGet<any>(
    `/api/v2/sales-history/${productId}/full`,
    params
  );
};

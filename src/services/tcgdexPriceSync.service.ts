// src/services/tcgdexPriceSync.service.ts
// TCGdex as primary price source.
// Fetches TCGPlayer + CardMarket prices for every card in every set.
// Run this to guarantee full price coverage across all 20k+ cards.

import { supabaseAdmin } from "../lib/supabase";
import { tcgdexClient } from "../lib/tcgdexClient";

const PAGE_SIZE = 1000;
const SET_DELAY_MS = 300;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Normalize TCGdex sv01-001 → DB sv1-001
const normalizeId = (id: string): string =>
  id.replace(/^([a-z]+)0(\d[a-z0-9]*)(-)/i, "$1$2$3");

const buildPriceRows = (
  cardId: string,
  tcgCard: any,
  expiresAt: string,
): any[] => {
  const rows: any[] = [];
  const now = new Date().toISOString();

  if (tcgCard.tcgplayer?.prices) {
    for (const [variant, prices] of Object.entries(
      tcgCard.tcgplayer.prices as Record<string, any>,
    )) {
      if (!prices || typeof prices !== "object") continue;
      const market = prices.marketPrice ?? prices.market ?? null;
      if (market == null) continue;
      rows.push({
        card_id: cardId,
        source: "tcgplayer",
        variant,
        grade: null,
        low_price: prices.lowPrice ?? prices.low ?? null,
        mid_price: prices.midPrice ?? prices.mid ?? null,
        high_price: prices.highPrice ?? prices.high ?? null,
        market_price: market,
        fetched_at: now,
        expires_at: expiresAt,
      });
    }
  }

  if (tcgCard.cardmarket?.prices) {
    const cm = tcgCard.cardmarket.prices;
    const market = cm.trendPrice ?? cm.averageSellPrice ?? cm.avg1 ?? null;
    if (market != null) {
      rows.push({
        card_id: cardId,
        source: "cardmarket",
        variant: "normal",
        grade: null,
        low_price: cm.lowPrice ?? null,
        mid_price: cm.averageSellPrice ?? null,
        high_price: null,
        market_price: market,
        fetched_at: now,
        expires_at: expiresAt,
      });
    }
  }

  return rows;
};

export const syncSetPrices = async (
  setId: string,
  tcgdexId: string,
): Promise<{ synced: number; noPrice: number }> => {
  const result = { synced: 0, noPrice: 0 };

  const { data: dbCards } = await supabaseAdmin
    .from("cards")
    .select("id")
    .eq("set_id", setId);

  if (!dbCards?.length) return result;

  const tcgCards = await tcgdexClient.getSetCards(tcgdexId);

  if (!tcgCards.length) {
    result.noPrice = dbCards.length;
    return result;
  }

  const tcgMap = new Map<string, any>();
  for (const card of tcgCards) {
    tcgMap.set(card.id, card);
    tcgMap.set(normalizeId(card.id), card);
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const allRows: any[] = [];

  for (const dbCard of dbCards) {
    const tcgCard = tcgMap.get(dbCard.id);
    if (!tcgCard) {
      result.noPrice++;
      continue;
    }
    const rows = buildPriceRows(dbCard.id, tcgCard, expiresAt);
    if (!rows.length) {
      result.noPrice++;
      continue;
    }
    allRows.push(...rows);
    result.synced++;
  }

  if (!allRows.length) return result;

  // Delete existing raw prices then insert fresh
  const cardIds = dbCards.map((c) => c.id);
  const CHUNK = 200;

  for (let i = 0; i < cardIds.length; i += CHUNK) {
    await supabaseAdmin
      .from("market_prices")
      .delete()
      .in("card_id", cardIds.slice(i, i + CHUNK))
      .is("grade", null);
  }

  for (let i = 0; i < allRows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("market_prices")
      .insert(allRows.slice(i, i + CHUNK));
    if (error) {
      console.error(
        `[TCGdexPriceSync] Insert error for ${setId}:`,
        error.message,
      );
      return result;
    }
  }

  return result;
};

export const syncAllPricesFromTCGdex = async (): Promise<void> => {
  console.log("[TCGdexPriceSync] Starting full price sync via TCGdex...");

  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards_tcgdex", status: "running" })
    .select()
    .single();

  const syncId = syncLog?.id;
  let page = 0;
  const allSets: any[] = [];

  while (true) {
    const { data } = await supabaseAdmin
      .from("sets")
      .select("id, name, tcgdex_id")
      .not("tcgdex_id", "is", null)
      .order("id")
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);
    if (!data?.length) break;
    allSets.push(...data);
    if (data.length < PAGE_SIZE) break;
    page++;
  }

  console.log(`[TCGdexPriceSync] Processing ${allSets.length} sets...`);

  let totalSynced = 0;
  let setsComplete = 0;

  for (const set of allSets) {
    console.log(
      `[TCGdexPriceSync] [${setsComplete + 1}/${allSets.length}] ${set.name} (${set.tcgdex_id})`,
    );
    const result = await syncSetPrices(set.id, set.tcgdex_id);
    totalSynced += result.synced;
    setsComplete++;
    console.log(
      `[TCGdexPriceSync]   ✓ ${result.synced} cards priced, ${result.noPrice} no price data`,
    );

    if (syncId) {
      await supabaseAdmin
        .from("price_sync_log")
        .update({ synced_items: totalSynced, total_items: allSets.length })
        .eq("id", syncId);
    }

    await delay(SET_DELAY_MS);
  }

  if (syncId) {
    await supabaseAdmin
      .from("price_sync_log")
      .update({
        status: "completed",
        completed_at: new Date().toISOString(),
        synced_items: totalSynced,
      })
      .eq("id", syncId);
  }

  console.log(`[TCGdexPriceSync] Complete — ${totalSynced} cards priced`);
};

export const syncSingleSetPrices = async (setId: string): Promise<void> => {
  const { data: set } = await supabaseAdmin
    .from("sets")
    .select("name, tcgdex_id")
    .eq("id", setId)
    .single();
  if (!set?.tcgdex_id) {
    console.error(`[TCGdexPriceSync] Set ${setId} has no tcgdex_id`);
    return;
  }
  const result = await syncSetPrices(setId, set.tcgdex_id);
  console.log(`[TCGdexPriceSync] Done — ${result.synced} cards priced`);
};

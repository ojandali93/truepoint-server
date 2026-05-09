// src/services/pokemontcgPriceSync.service.ts
// Syncs TCGPlayer USD prices per variant for all cards using pokemontcg.io.
// pokemontcg.io pulls directly from TCGPlayer and returns USD prices updated daily.
// Stores source='tcgplayer' rows in market_prices — these take priority over
// CardMarket's stale EUR-converted TCGPlayer prices.

import { supabaseAdmin } from "../lib/supabase";
import { pokemonTcgClient } from "../lib/pokemonTcgClient";

const PAGE_SIZE = 250; // pokemontcg.io max per page
const DELAY_MS = 100; // small delay between pages — API is generous with rate limits
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Build price rows from pokemontcg.io card ────────────────────────────────

const buildRows = (card: any, expiresAt: string): any[] => {
  if (!card.tcgplayer?.prices) return [];

  const now = new Date().toISOString();
  const rows: any[] = [];

  for (const [variant, prices] of Object.entries(
    card.tcgplayer.prices as Record<string, any>,
  )) {
    const market = prices?.market ?? null;
    if (market == null) continue; // skip variants with no market price

    rows.push({
      card_id: card.id,
      source: "tcgplayer",
      variant, // e.g. 'normal', 'reverseHolofoil', 'holofoil'
      grade: null,
      low_price: prices?.low ?? null,
      mid_price: prices?.mid ?? null,
      high_price: prices?.high ?? null,
      market_price: market,
      fetched_at: now,
      expires_at: expiresAt,
    });
  }

  return rows;
};

// ─── Main sync ────────────────────────────────────────────────────────────────

export const syncAllTCGPlayerPrices = async (): Promise<void> => {
  console.log("[PTCGPriceSync] Starting pokemontcg.io USD price sync...");

  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards_pokemontcg", status: "running" })
    .select()
    .single();

  const syncId = syncLog?.id;
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();

  let page = 1;
  let totalSynced = 0;
  let totalNoPrice = 0;
  let totalCards = 0;

  while (true) {
    console.log(`[PTCGPriceSync] Page ${page}...`);

    let cards: any[] = [];
    try {
      const result = await pokemonTcgClient.getAllCards(page, PAGE_SIZE);
      cards = result?.data ?? [];
      if (!totalCards && result?.totalCount) {
        totalCards = result.totalCount;
        console.log(
          `[PTCGPriceSync] Total cards in pokemontcg.io: ${totalCards}`,
        );
      }
    } catch (err: any) {
      console.error(`[PTCGPriceSync] Page ${page} failed:`, err?.message);
      break;
    }

    if (!cards.length) break;

    // Build all price rows for this page
    const allRows: any[] = [];
    const cardIdsThisPage: string[] = [];

    for (const card of cards) {
      cardIdsThisPage.push(card.id);
      const rows = buildRows(card, expiresAt);
      if (rows.length) {
        allRows.push(...rows);
        totalSynced++;
      } else {
        totalNoPrice++;
      }
    }

    // Delete existing tcgplayer rows for these cards then insert fresh
    const CHUNK = 200;
    for (let i = 0; i < cardIdsThisPage.length; i += CHUNK) {
      await supabaseAdmin
        .from("market_prices")
        .delete()
        .in("card_id", cardIdsThisPage.slice(i, i + CHUNK))
        .eq("source", "tcgplayer")
        .is("grade", null);
    }

    // Insert new rows in chunks
    for (let i = 0; i < allRows.length; i += CHUNK) {
      const { error } = await supabaseAdmin
        .from("market_prices")
        .insert(allRows.slice(i, i + CHUNK));
      if (error) {
        console.error(
          `[PTCGPriceSync] Insert error page ${page}:`,
          error.message,
        );
      }
    }

    console.log(
      `[PTCGPriceSync] Page ${page}: ${cards.length} cards, ` +
        `${allRows.length} price rows inserted (${totalNoPrice} no price so far)`,
    );

    // Update progress
    if (syncId) {
      await supabaseAdmin
        .from("price_sync_log")
        .update({ synced_items: totalSynced, total_items: totalCards })
        .eq("id", syncId);
    }

    if (cards.length < PAGE_SIZE) break; // last page
    page++;
    await delay(DELAY_MS);
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

  console.log(
    `[PTCGPriceSync] Complete — ${totalSynced} cards with USD prices, ` +
      `${totalNoPrice} cards had no TCGPlayer price data`,
  );
};

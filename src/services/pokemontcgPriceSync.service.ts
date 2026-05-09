// src/services/pokemontcgPriceSync.service.ts
// Syncs TCGPlayer USD prices per variant for all cards using pokemontcg.io.
// pokemontcg.io pulls directly from TCGPlayer and returns USD prices updated daily.
// Stores source='tcgplayer' rows in market_prices — these take priority over
// CardMarket's stale EUR-converted TCGPlayer prices.

import { supabaseAdmin } from "../lib/supabase";
import { pokemonTcgClient } from "../lib/pokemonTcgClient";

const PAGE_SIZE = 100; // smaller pages = less timeout risk
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
    // Retry up to 3 times on timeout
    let attempts = 0;
    while (attempts < 3) {
      try {
        const result = await pokemonTcgClient.getAllCards(page, PAGE_SIZE);
        cards = result?.data ?? [];
        if (!totalCards && result?.totalCount) {
          totalCards = result.totalCount;
          console.log(
            `[PTCGPriceSync] Total cards in pokemontcg.io: ${totalCards}`,
          );
        }
        break; // success
      } catch (err: any) {
        attempts++;
        if (attempts >= 3) {
          console.error(
            `[PTCGPriceSync] Page ${page} failed after 3 attempts:`,
            err?.message,
          );
          // Skip this page and continue rather than aborting the whole sync
          cards = [];
          break;
        }
        console.warn(
          `[PTCGPriceSync] Page ${page} attempt ${attempts} failed, retrying in 5s...`,
        );
        await delay(5000);
      }
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

  // Convert remaining EUR prices to USD for cards pokemontcg.io doesn't have
  await convertRemainingEURToUSD();
};

// ─── EUR → USD conversion for cards not in pokemontcg.io ─────────────────────
// Fetches live EUR/USD rate, finds cards with CardMarket EUR prices but no
// TCGPlayer USD price, converts and stores as source='tcgplayer'.

const convertRemainingEURToUSD = async (): Promise<void> => {
  console.log("[PTCGPriceSync] Converting remaining EUR prices to USD...");

  // Fetch live EUR/USD exchange rate
  let eurToUsd = 1.09; // fallback rate
  try {
    const res = await fetch("https://api.exchangerate-api.com/v4/latest/EUR");
    if (res.ok) {
      const data = (await res.json()) as { rates?: { USD?: number } };
      eurToUsd = data?.rates?.USD ?? 1.09;
      console.log(`[PTCGPriceSync] Live EUR/USD rate: ${eurToUsd}`);
    }
  } catch {
    console.log(
      `[PTCGPriceSync] Could not fetch live rate — using fallback: ${eurToUsd}`,
    );
  }

  // Find cards that have cardmarket prices but no tcgplayer prices
  // Do this in pages to avoid loading everything at once
  const PAGE = 1000;
  let offset = 0;
  let converted = 0;

  while (true) {
    // Get cards that have cardmarket source but no tcgplayer source
    const { data: eurRows } = await supabaseAdmin
      .from("market_prices")
      .select("card_id, market_price, low_price, mid_price, fetched_at")
      .eq("source", "cardmarket")
      .is("grade", null)
      .range(offset, offset + PAGE - 1);

    if (!eurRows?.length) break;

    // Find which of these card IDs already have a tcgplayer row
    const cardIds = [...new Set(eurRows.map((r) => r.card_id))];
    const { data: existing } = await supabaseAdmin
      .from("market_prices")
      .select("card_id")
      .eq("source", "tcgplayer")
      .is("grade", null)
      .in("card_id", cardIds);

    const hasUSD = new Set((existing ?? []).map((r) => r.card_id));
    const needsConversion = eurRows.filter((r) => !hasUSD.has(r.card_id));

    if (!needsConversion.length) {
      offset += PAGE;
      if (eurRows.length < PAGE) break;
      continue;
    }

    // Build USD rows from EUR prices
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
    const usdRows = needsConversion
      .map((row) => ({
        card_id: row.card_id,
        source: "tcgplayer",
        variant: "normal",
        grade: null,
        low_price: row.low_price
          ? Math.round(row.low_price * eurToUsd * 100) / 100
          : null,
        mid_price: null,
        high_price: null,
        market_price: row.market_price
          ? Math.round(row.market_price * eurToUsd * 100) / 100
          : null,
        fetched_at: new Date().toISOString(),
        expires_at: expiresAt,
      }))
      .filter((r) => r.market_price != null);

    // Insert in chunks
    const CHUNK = 500;
    for (let i = 0; i < usdRows.length; i += CHUNK) {
      const { error } = await supabaseAdmin
        .from("market_prices")
        .upsert(usdRows.slice(i, i + CHUNK), {
          onConflict: "card_id,source,variant,grade",
        });
      if (error) {
        // upsert may fail without unique constraint — try insert instead
        const { error: insertErr } = await supabaseAdmin
          .from("market_prices")
          .insert(usdRows.slice(i, i + CHUNK));
        if (insertErr) {
          console.warn(
            `[PTCGPriceSync] Insert fallback failed:`,
            insertErr.message,
          );
        }
      }
    }

    converted += usdRows.length;
    offset += PAGE;
    if (eurRows.length < PAGE) break;
  }

  console.log(
    `[PTCGPriceSync] Converted ${converted} EUR prices to USD (rate: ${eurToUsd})`,
  );
};

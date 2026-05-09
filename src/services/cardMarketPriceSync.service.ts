// src/services/cardMarketPriceSync.service.ts
// Bulk price sync using CardMarket RapidAPI.
// Uses the expansions endpoint to get all cards per set in bulk
// rather than per-card lookups — much more efficient.
//
// Flow:
//   GET /pokemon/episodes → all expansions with CardMarket IDs
//   GET /pokemon/episodes/:id/products → all cards with prices
//   Match to our DB cards by set + card number
//   Store to market_prices table

import { supabaseAdmin } from "../lib/supabase";
import { cardMarketClient } from "../lib/cardMarketClient";

const DELAY_MS = 500; // between expansion fetches to respect rate limits
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Normalize card number for matching ───────────────────────────────────────
// CardMarket uses "001", our DB uses "1" — strip leading zeros
const normalizeNumber = (n: string): string => n.replace(/^0+/, "") || "0";

// ─── Fetch all our sets from DB ───────────────────────────────────────────────

const fetchOurSets = async (): Promise<
  Map<string, { id: string; name: string }>
> => {
  const map = new Map<string, { id: string; name: string }>();
  const { data } = await supabaseAdmin.from("sets").select("id, name");
  for (const set of data ?? []) {
    map.set(set.id, set);
    // Also index by normalized name for matching
    map.set(set.name.toLowerCase().trim(), set);
  }
  return map;
};

// ─── Match CardMarket expansion to our set ────────────────────────────────────

const matchExpansionToSet = (
  expansion: { name: string; code: string },
  ourSets: Map<string, any>,
): string | null => {
  // Try direct code match
  const byCode = ourSets.get(expansion.code.toLowerCase());
  if (byCode) return byCode.id;

  // Try name match
  const byName = ourSets.get(expansion.name.toLowerCase().trim());
  if (byName) return byName.id;

  return null;
};

// ─── Sync prices for one expansion ───────────────────────────────────────────

const syncExpansionPrices = async (
  expansionId: number,
  expansionName: string,
  setId: string,
): Promise<{ synced: number; noMatch: number; noPrice: number }> => {
  const result = { synced: 0, noMatch: 0, noPrice: 0 };

  console.log(
    `[CardMarketPriceSync] Syncing "${expansionName}" (${expansionId}) → DB set ${setId}`,
  );

  // Get all cards for this expansion from CardMarket
  const cmCards = await cardMarketClient.getProductsByExpansion(expansionId);

  if (!cmCards.length) return result;

  // Get our DB cards for this set (id + number)
  const { data: dbCards } = await supabaseAdmin
    .from("cards")
    .select("id, number")
    .eq("set_id", setId);

  if (!dbCards?.length) return result;

  // Build lookup: normalized number → card ID
  const numberMap = new Map<string, string>();
  for (const card of dbCards) {
    numberMap.set(normalizeNumber(card.number), card.id);
    numberMap.set(card.number, card.id); // also keep original
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const rows: any[] = [];

  for (const cmCard of cmCards) {
    const cardNum = normalizeNumber(cmCard.card_number);
    const cardId = numberMap.get(cardNum) ?? numberMap.get(cmCard.card_number);

    if (!cardId) {
      result.noMatch++;
      continue;
    }

    const prices = cmCard.prices;
    let hasPrice = false;

    // TCGPlayer singles price (primary)
    if (prices?.tcg_player?.market_price != null) {
      rows.push({
        card_id: cardId,
        source: "tcgplayer",
        variant: "normal",
        grade: null,
        low_price: null,
        mid_price: prices.tcg_player.mid_price ?? null,
        high_price: null,
        market_price: prices.tcg_player.market_price,
        fetched_at: now,
        expires_at: expiresAt,
      });
      hasPrice = true;
    }

    // CardMarket raw price
    if (prices?.cardmarket) {
      const cm = prices.cardmarket;
      const market =
        cm["30d_average"] ?? cm["7d_average"] ?? cm.lowest_near_mint ?? null;
      if (market != null) {
        rows.push({
          card_id: cardId,
          source: "cardmarket",
          variant: "normal",
          grade: null,
          low_price: cm.lowest_near_mint ?? null,
          mid_price: cm["7d_average"] ?? null,
          high_price: cm["30d_average"] ?? null,
          market_price: market,
          fetched_at: now,
          expires_at: expiresAt,
        });
        hasPrice = true;
      }
    }

    // Graded prices (PSA/BGS/CGC from CardMarket)
    if (prices?.cardmarket?.graded) {
      const graded = prices.cardmarket.graded;
      const companies = ["psa", "bgs", "cgc"] as const;
      for (const company of companies) {
        const grades = graded[company];
        if (!grades) continue;
        for (const [gradeKey, price] of Object.entries(grades)) {
          if (price == null) continue;
          const gradeNum = gradeKey.replace(company, "");
          rows.push({
            card_id: cardId,
            source: "cardmarket",
            variant: "normal",
            grade: `${company.toUpperCase()} ${gradeNum}`,
            low_price: null,
            mid_price: null,
            high_price: null,
            market_price: price as number,
            fetched_at: now,
            expires_at: expiresAt,
          });
        }
      }
    }

    // eBay graded prices
    if (prices?.ebay?.graded) {
      for (const [company, grades] of Object.entries(prices.ebay.graded)) {
        for (const [grade, data] of Object.entries(
          grades as Record<string, any>,
        )) {
          if (!data?.median_price) continue;
          rows.push({
            card_id: cardId,
            source: "ebay",
            variant: "normal",
            grade: `${company.toUpperCase()} ${grade}`,
            low_price: null,
            mid_price: null,
            high_price: null,
            market_price: data.median_price,
            fetched_at: now,
            expires_at: expiresAt,
          });
        }
      }
    }

    if (hasPrice) result.synced++;
    else result.noPrice++;
  }

  if (!rows.length) return result;

  // Delete existing prices for this set's cards then insert fresh
  const cardIds = [...new Set(rows.map((r) => r.card_id))];
  const CHUNK = 200;

  for (let i = 0; i < cardIds.length; i += CHUNK) {
    await supabaseAdmin
      .from("market_prices")
      .delete()
      .in("card_id", cardIds.slice(i, i + CHUNK));
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("market_prices")
      .insert(rows.slice(i, i + CHUNK));

    if (error) {
      console.error(`[CMPriceSync] Insert error for ${setId}:`, error.message);
    }
  }

  return result;
};

// ─── Main sync ─────────────────────────────────────────────────────────────────

export const syncAllPricesFromCardMarket = async (): Promise<void> => {
  console.log("[CMPriceSync] Starting CardMarket bulk price sync...");

  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards_cardmarket", status: "running" })
    .select()
    .single();

  const syncId = syncLog?.id;

  // Get all CardMarket expansions
  console.log("[CMPriceSync] Fetching all expansions from CardMarket...");
  let expansions: any[] = [];
  try {
    expansions = await cardMarketClient.getAllExpansions();
  } catch (err: any) {
    console.error("[CMPriceSync] Failed to fetch expansions:", err?.message);
    return;
  }

  console.log(`[CMPriceSync] Found ${expansions.length} CardMarket expansions`);

  // Get our sets for matching
  const ourSets = await fetchOurSets();

  let totalSynced = 0;
  let totalNoMatch = 0;
  let setsProcessed = 0;
  let setsSkipped = 0;

  for (const expansion of expansions) {
    const setId = matchExpansionToSet(expansion, ourSets);

    if (!setId) {
      console.log(
        `[CMPriceSync] No match for: ${expansion.name} (${expansion.code})`,
      );
      setsSkipped++;
      continue;
    }

    console.log(
      `[CMPriceSync] [${setsProcessed + setsSkipped + 1}/${expansions.length}] ` +
        `${expansion.name} → ${setId}`,
    );

    try {
      const result = await syncExpansionPrices(
        expansion.id,
        expansion.name,
        setId,
      );
      totalSynced += result.synced;
      totalNoMatch += result.noMatch;
      setsProcessed++;

      console.log(
        `[CMPriceSync]   ✓ ${result.synced} priced, ` +
          `${result.noMatch} no match, ${result.noPrice} no price`,
      );
    } catch (err: any) {
      console.error(`[CMPriceSync] Error for ${expansion.name}:`, err?.message);
    }

    if (syncId) {
      await supabaseAdmin
        .from("price_sync_log")
        .update({ synced_items: totalSynced })
        .eq("id", syncId);
    }

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
    `[CMPriceSync] Complete — ${totalSynced} cards priced across ${setsProcessed} sets. ` +
      `${setsSkipped} expansions had no matching set.`,
  );
};

// ─── Sync a single set ─────────────────────────────────────────────────────────

export const syncSetPricesFromCardMarket = async (
  setId: string,
): Promise<void> => {
  const { data: set } = await supabaseAdmin
    .from("sets")
    .select("name")
    .eq("id", setId)
    .single();

  if (!set) {
    console.error(`[CMPriceSync] Set ${setId} not found`);
    return;
  }

  // Find matching CardMarket expansion by name
  const expansions = await cardMarketClient.getAllExpansions();
  const ourSets = await fetchOurSets();

  const match = expansions.find((e) => {
    const matched = matchExpansionToSet(e, ourSets);
    return matched === setId;
  });

  if (!match) {
    console.error(`[CMPriceSync] No CardMarket expansion found for ${setId}`);
    return;
  }

  const result = await syncExpansionPrices(match.id, match.name, setId);
  console.log(`[CMPriceSync] ${set.name}: ${result.synced} cards priced`);
};

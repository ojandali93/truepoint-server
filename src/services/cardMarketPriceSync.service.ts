// src/services/cardMarketPriceSync.service.ts
import { supabaseAdmin } from "../lib/supabase";
import { cardMarketClient } from "../lib/cardMarketClient";

const DELAY_MS = 500;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// card_number comes back as integer from CardMarket — convert to string first
const normalizeNumber = (n: number | string): string =>
  String(n).replace(/^0+/, "") || "0";

const fetchOurSets = async (): Promise<Map<string, { id: string; name: string }>> => {
  const map = new Map<string, { id: string; name: string }>();
  const { data } = await supabaseAdmin.from("sets").select("id, name");
  for (const set of data ?? []) {
    map.set(set.id, set);
    map.set(set.name.toLowerCase().trim(), set);
  }
  return map;
};

const matchExpansionToSet = (
  expansion: { name: string | null; code: string | null },
  ourSets: Map<string, any>
): string | null => {
  if (expansion.code) {
    const byCode = ourSets.get(expansion.code.toLowerCase());
    if (byCode) return byCode.id;
  }
  if (expansion.name) {
    const byName = ourSets.get(expansion.name.toLowerCase().trim());
    if (byName) return byName.id;
  }
  return null;
};

// Parse graded price keys like "psa10" → { company: "PSA", grade: "10" }
const parseGradeKey = (key: string): { company: string; grade: string } | null => {
  const match = key.match(/^(psa|bgs|cgc|sgc|tag|ace|gma)(\d+\.?\d*)$/i);
  if (!match) return null;
  return { company: match[1].toUpperCase(), grade: match[2] };
};

const syncExpansionPrices = async (
  expansionId: number,
  expansionName: string,
  setId: string
): Promise<{ synced: number; noMatch: number; noPrice: number }> => {
  const result = { synced: 0, noMatch: 0, noPrice: 0 };

  console.log(`[CMPriceSync] Fetching cards for expansion ${expansionId} (${expansionName})...`);
  const cmCards = await cardMarketClient.getCardsByExpansion(expansionId);
  console.log(`[CMPriceSync] Got ${cmCards.length} cards from CardMarket`);

  if (!cmCards.length) return result;

  // Log sample to verify structure
  const s = cmCards[0] as any;
  console.log(`[CMPriceSync] Sample: #${s.card_number} ${s.name}, tcg_player=$${s.prices?.tcg_player?.market_price}`);

  const { data: dbCards } = await supabaseAdmin
    .from("cards")
    .select("id, number")
    .eq("set_id", setId);

  if (!dbCards?.length) return result;

  // Build lookup: normalized number string → card ID
  const numberMap = new Map<string, string>();
  for (const card of dbCards) {
    numberMap.set(normalizeNumber(card.number), card.id);
    numberMap.set(String(card.number), card.id);
  }

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const rows: any[] = [];

  for (const rawCard of cmCards) {
    const cmCard = rawCard as any;
    if (cmCard.card_number == null) { result.noMatch++; continue; }

    const cardNum = normalizeNumber(cmCard.card_number);
    const cardId = numberMap.get(cardNum);

    if (!cardId) {
      if (result.noMatch < 3) {
        console.log(`[CMPriceSync] No DB match for CM #${cmCard.card_number} (normalized: ${cardNum})`);
      }
      result.noMatch++;
      continue;
    }

    const prices = cmCard.prices;
    let hasPrice = false;

    // TCGPlayer singles price
    if (prices?.tcg_player?.market_price != null) {
      rows.push({
        card_id: cardId, source: "tcgplayer", variant: "normal", grade: null,
        low_price: null,
        mid_price: prices.tcg_player.mid_price ?? null,
        high_price: null,
        market_price: prices.tcg_player.market_price,
        fetched_at: now, expires_at: expiresAt,
      });
      hasPrice = true;
    }

    // CardMarket raw price
    if (prices?.cardmarket) {
      const cm = prices.cardmarket;
      const market = cm["30d_average"] ?? cm["7d_average"] ?? cm.lowest_near_mint ?? null;
      if (market != null) {
        rows.push({
          card_id: cardId, source: "cardmarket", variant: "normal", grade: null,
          low_price: cm.lowest_near_mint ?? null,
          mid_price: cm["7d_average"] ?? null,
          high_price: cm["30d_average"] ?? null,
          market_price: market,
          fetched_at: now, expires_at: expiresAt,
        });
        hasPrice = true;
      }

      // CardMarket graded — keys like "psa10", "cgc9", "bgs9"
      // graded can be an object OR an empty array — check it's actually an object
      if (prices.cardmarket.graded && !Array.isArray(prices.cardmarket.graded)) {
        for (const [, grades] of Object.entries(prices.cardmarket.graded as Record<string, any>)) {
          if (!grades || typeof grades !== "object") continue;
          for (const [gradeKey, price] of Object.entries(grades as Record<string, number>)) {
            if (price == null) continue;
            const parsed = parseGradeKey(gradeKey);
            if (!parsed) continue;
            rows.push({
              card_id: cardId, source: "cardmarket", variant: "normal",
              grade: `${parsed.company} ${parsed.grade}`,
              low_price: null, mid_price: null, high_price: null,
              market_price: price,
              fetched_at: now, expires_at: expiresAt,
            });
          }
        }
      }
    }

    // eBay graded prices — keys are plain numbers like "9", "10"
    if (prices?.ebay?.graded && !Array.isArray(prices.ebay.graded)) {
      for (const [company, grades] of Object.entries(prices.ebay.graded as Record<string, any>)) {
        if (!grades || typeof grades !== "object") continue;
        for (const [grade, data] of Object.entries(grades as Record<string, any>)) {
          if (!data?.median_price) continue;
          rows.push({
            card_id: cardId, source: "ebay", variant: "normal",
            grade: `${company.toUpperCase()} ${grade}`,
            low_price: null, mid_price: null, high_price: null,
            market_price: data.median_price,
            fetched_at: now, expires_at: expiresAt,
          });
        }
      }
    }

    if (hasPrice) {
      result.synced++;
      if (result.synced <= 2) {
        console.log(`[CMPriceSync] ✓ #${cmCard.card_number} ${cmCard.name}: $${prices?.tcg_player?.market_price}`);
      }
    } else {
      result.noPrice++;
    }
  }

  console.log(`[CMPriceSync] ${result.synced} priced, ${result.noMatch} no DB match, ${result.noPrice} no price`);

  if (!rows.length) return result;

  // Delete existing prices then insert fresh
  const cardIds = [...new Set(rows.map((r) => r.card_id))];
  const CHUNK = 200;

  for (let i = 0; i < cardIds.length; i += CHUNK) {
    await supabaseAdmin.from("market_prices").delete()
      .in("card_id", cardIds.slice(i, i + CHUNK));
  }

  for (let i = 0; i < rows.length; i += CHUNK) {
    const { error } = await supabaseAdmin.from("market_prices").insert(rows.slice(i, i + CHUNK));
    if (error) console.error(`[CMPriceSync] Insert error for ${setId}:`, error.message);
  }

  console.log(`[CMPriceSync] Inserted ${rows.length} price rows for ${setId}`);
  return result;
};

export const syncAllPricesFromCardMarket = async (): Promise<void> => {
  console.log("[CMPriceSync] Starting CardMarket bulk price sync...");

  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards_cardmarket", status: "running" })
    .select().single();

  const syncId = syncLog?.id;

  let expansions: any[] = [];
  try {
    console.log("[CMPriceSync] Fetching all expansions...");
    expansions = await cardMarketClient.getAllExpansions();
    console.log(`[CMPriceSync] Found ${expansions.length} expansions`);
  } catch (err: any) {
    console.error("[CMPriceSync] Failed to fetch expansions:", err?.message);
    return;
  }

  const ourSets = await fetchOurSets();
  let totalSynced = 0;
  let setsProcessed = 0;
  let setsSkipped = 0;

  for (const expansion of expansions) {
    if (!expansion?.id) { setsSkipped++; continue; }

    const setId = matchExpansionToSet(expansion, ourSets);
    if (!setId) {
      setsSkipped++;
      continue;
    }

    console.log(`[CMPriceSync] [${setsProcessed + setsSkipped + 1}/${expansions.length}] ${expansion.name} → ${setId}`);

    try {
      const result = await syncExpansionPrices(expansion.id, expansion.name ?? setId, setId);
      totalSynced += result.synced;
      setsProcessed++;
    } catch (err: any) {
      console.error(`[CMPriceSync] Error for ${expansion.name}:`, err?.message);
    }

    if (syncId) {
      await supabaseAdmin.from("price_sync_log")
        .update({ synced_items: totalSynced }).eq("id", syncId);
    }

    await delay(DELAY_MS);
  }

  if (syncId) {
    await supabaseAdmin.from("price_sync_log").update({
      status: "completed",
      completed_at: new Date().toISOString(),
      synced_items: totalSynced,
    }).eq("id", syncId);
  }

  console.log(`[CMPriceSync] Done — ${totalSynced} cards priced across ${setsProcessed} sets. ${setsSkipped} skipped.`);
};

export const syncSetPricesFromCardMarket = async (setId: string): Promise<void> => {
  const { data: set } = await supabaseAdmin.from("sets").select("name").eq("id", setId).single();
  if (!set) { console.error(`[CMPriceSync] Set ${setId} not found`); return; }

  const expansions = await cardMarketClient.getAllExpansions();
  const ourSets = await fetchOurSets();
  const match = expansions.find((e: any) => e && matchExpansionToSet(e, ourSets) === setId);

  if (!match) {
    console.error(`[CMPriceSync] No CardMarket expansion found for ${setId}`);
    return;
  }

  console.log(`[CMPriceSync] Matched: ${(match as any).name} (id: ${(match as any).id})`);
  const result = await syncExpansionPrices((match as any).id, (match as any).name ?? setId, setId);
  console.log(`[CMPriceSync] ${set.name}: ${result.synced} cards priced`);
};

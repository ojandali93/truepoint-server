// src/services/cardMarketPriceSync.service.ts
import { supabaseAdmin } from "../lib/supabase";
import { cardMarketClient } from "../lib/cardMarketClient";

const DELAY_MS = 500;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const normalizeNumber = (n: string): string => n?.replace(/^0+/, "") || "0";

const fetchOurSets = async (): Promise<
  Map<string, { id: string; name: string }>
> => {
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
  ourSets: Map<string, any>,
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

const syncExpansionPrices = async (
  expansionId: number,
  expansionName: string,
  setId: string,
): Promise<{ synced: number; noMatch: number; noPrice: number }> => {
  const result = { synced: 0, noMatch: 0, noPrice: 0 };

  console.log(
    `[CMPriceSync] Fetching CardMarket products for expansion ${expansionId} (${expansionName})...`,
  );
  const cmCards = await cardMarketClient.getProductsByExpansion(expansionId);
  console.log(`[CMPriceSync] CardMarket returned ${cmCards.length} products`);

  if (!cmCards.length) {
    console.log(
      `[CMPriceSync] No products returned — expansion may be empty or wrong ID`,
    );
    return result;
  }

  // Log first card structure so we can see what fields are available
  const sample = cmCards[0];
  console.log(
    `[CMPriceSync] Sample card: ${JSON.stringify({
      id: sample.id,
      name: sample.name,
      card_number: sample.card_number,
      prices: sample.prices,
    })}`,
  );

  const { data: dbCards } = await supabaseAdmin
    .from("cards")
    .select("id, number")
    .eq("set_id", setId);

  console.log(
    `[CMPriceSync] DB has ${dbCards?.length ?? 0} cards for set ${setId}`,
  );

  if (!dbCards?.length) return result;

  const numberMap = new Map<string, string>();
  for (const card of dbCards) {
    numberMap.set(normalizeNumber(card.number), card.id);
    numberMap.set(card.number, card.id);
  }

  // Log a few DB numbers vs CM numbers to spot mismatches
  const sampleDbNums = dbCards.slice(0, 3).map((c) => c.number);
  const sampleCmNums = cmCards.slice(0, 3).map((c) => c.card_number);
  console.log(`[CMPriceSync] Sample DB numbers: ${sampleDbNums.join(", ")}`);
  console.log(`[CMPriceSync] Sample CM numbers: ${sampleCmNums.join(", ")}`);

  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const rows: any[] = [];

  for (const cmCard of cmCards) {
    if (!cmCard.card_number) {
      result.noMatch++;
      continue;
    }

    const cardNum = normalizeNumber(cmCard.card_number);
    const cardId = numberMap.get(cardNum) ?? numberMap.get(cmCard.card_number);

    if (!cardId) {
      if (result.noMatch < 3) {
        console.log(
          `[CMPriceSync] No DB match for CM card #${cmCard.card_number} (normalized: ${cardNum})`,
        );
      }
      result.noMatch++;
      continue;
    }

    const prices = cmCard.prices;
    let hasPrice = false;

    // TCGPlayer singles price
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

    // Graded prices
    if (prices?.cardmarket?.graded) {
      const graded = prices.cardmarket.graded;
      const companies = ["psa", "bgs", "cgc"] as const;
      for (const company of companies) {
        const grades = graded[company];
        if (!grades) continue;
        for (const [gradeKey, price] of Object.entries(grades)) {
          if (price == null) continue;
          rows.push({
            card_id: cardId,
            source: "cardmarket",
            variant: "normal",
            grade: `${company.toUpperCase()} ${gradeKey.replace(company, "")}`,
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

    if (hasPrice) {
      result.synced++;
      if (result.synced <= 3) {
        console.log(
          `[CMPriceSync] ✓ Card #${cmCard.card_number} → ${cardId}: tcg=${prices?.tcg_player?.market_price ?? "null"}, cm=${prices?.cardmarket?.["30d_average"] ?? "null"}`,
        );
      }
    } else {
      result.noPrice++;
      if (result.noPrice <= 3) {
        console.log(
          `[CMPriceSync] No price for card #${cmCard.card_number}: prices=${JSON.stringify(prices)}`,
        );
      }
    }
  }

  console.log(
    `[CMPriceSync] Summary: ${result.synced} priced, ${result.noMatch} no match, ${result.noPrice} no price`,
  );

  if (!rows.length) return result;

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
    if (error)
      console.error(`[CMPriceSync] Insert error for ${setId}:`, error.message);
  }

  console.log(`[CMPriceSync] Inserted ${rows.length} price rows for ${setId}`);
  return result;
};

export const syncAllPricesFromCardMarket = async (): Promise<void> => {
  console.log("[CMPriceSync] Starting CardMarket bulk price sync...");

  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards_cardmarket", status: "running" })
    .select()
    .single();

  const syncId = syncLog?.id;

  let expansions: any[] = [];
  try {
    console.log("[CMPriceSync] Fetching all expansions from CardMarket...");
    expansions = await cardMarketClient.getAllExpansions();
    console.log(
      `[CMPriceSync] Found ${expansions.length} CardMarket expansions`,
    );
  } catch (err: any) {
    console.error("[CMPriceSync] Failed to fetch expansions:", err?.message);
    return;
  }

  const ourSets = await fetchOurSets();
  let totalSynced = 0;
  let setsProcessed = 0;
  let setsSkipped = 0;

  for (const expansion of expansions) {
    if (!expansion?.id) {
      setsSkipped++;
      continue;
    }

    const setId = matchExpansionToSet(expansion, ourSets);

    if (!setId) {
      console.log(
        `[CMPriceSync] No match: ${expansion.name ?? "unnamed"} (${expansion.code ?? "no code"})`,
      );
      setsSkipped++;
      continue;
    }

    console.log(
      `[CMPriceSync] [${setsProcessed + setsSkipped + 1}/${expansions.length}] ${expansion.name} → ${setId}`,
    );

    try {
      const result = await syncExpansionPrices(
        expansion.id,
        expansion.name ?? setId,
        setId,
      );
      totalSynced += result.synced;
      setsProcessed++;
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
    `[CMPriceSync] Complete — ${totalSynced} cards priced across ${setsProcessed} sets. ${setsSkipped} skipped.`,
  );
};

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

  console.log(`[CMPriceSync] Finding CardMarket expansion for ${set.name}...`);
  const expansions = await cardMarketClient.getAllExpansions();
  const ourSets = await fetchOurSets();

  const match = expansions.find(
    (e) => e && matchExpansionToSet(e, ourSets) === setId,
  );

  if (!match) {
    console.error(`[CMPriceSync] No CardMarket expansion found for ${setId}`);
    console.log(
      `[CMPriceSync] Available expansions (first 10): ${expansions
        .slice(0, 10)
        .map((e: any) => `${e.name} (${e.code})`)
        .join(", ")}`,
    );
    return;
  }

  console.log(
    `[CMPriceSync] Matched to CardMarket expansion: ${match.name} (id: ${match.id}, code: ${match.code})`,
  );
  const result = await syncExpansionPrices(
    match.id,
    match.name ?? setId,
    setId,
  );
  console.log(`[CMPriceSync] ${set.name}: ${result.synced} cards priced`);
};

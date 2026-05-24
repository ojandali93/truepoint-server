// src/services/tcgapisSkuSync.service.ts
// SKU-level (condition-aware) catalog + pricing sync from TCGAPIs.
// Complements tcgapisSync.service.ts (which handles variant-level prices).
//
// Tables written:
//   card_skus   — one row per buyable SKU (condition × printing × edition × language)
//   sku_prices  — latest price per SKU (refreshed nightly)
//   price_sync_log — progress + failure tracking
//
// Endpoint used: GET /api/v1/skuprices/product/{productId}
//   → returns every SKU + price for a product in ONE call (efficient).

import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";
import {
  tcgapisGet,
  resolveVariant,
  normalizeCondition,
  parseSkuPricesResponse,
  sleep,
  NormalizedSku,
} from "../lib/tcgapisClient";

const SKU_PRICE_TTL_MS = 48 * 60 * 60 * 1000; // 48h — covers a missed nightly run

// One-time debug switch: logs the first raw SKU response so you can confirm
// the real response shape against parseSkuPricesResponse. Set false after.
const DEBUG_FIRST_RESPONSE = true;
let debugLogged = false;

// ─── Sync all SKUs + prices for a single product ──────────────────────────────

export const syncSkusForProduct = async (
  cardId: string,
  productId: number,
): Promise<{ skus: number; prices: number }> => {
  const raw = await tcgapisGet<any>(`/api/v1/skuprices/product/${productId}`);

  if (DEBUG_FIRST_RESPONSE && !debugLogged) {
    debugLogged = true;
    console.log(
      "[SKU-SYNC] First raw /skuprices/product response:",
      JSON.stringify(raw).slice(0, 2000),
    );
  }

  const skus: NormalizedSku[] = parseSkuPricesResponse(raw);
  if (!skus.length) return { skus: 0, prices: 0 };

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + SKU_PRICE_TTL_MS).toISOString();

  // Build batch upserts
  const skuRows = skus.map((s) => {
    const printing = s.printing ?? "Normal";
    const variantDef = resolveVariant(printing);
    return {
      tcgapis_sku_id: s.skuId,
      card_id: cardId,
      tcgapis_product_id: productId,
      condition: s.condition,
      condition_code: normalizeCondition(s.condition),
      printing,
      variant_type: variantDef.type,
      edition: s.edition,
      language: s.language ?? "English",
      updated_at: now,
    };
  });

  const priceRows = skus
    .filter((s) => s.marketPrice != null || s.lowPrice != null)
    .map((s) => ({
      tcgapis_sku_id: s.skuId,
      card_id: cardId,
      low_price: s.lowPrice,
      mid_price: s.midPrice,
      high_price: s.highPrice,
      market_price: s.marketPrice,
      direct_low_price: s.directLowPrice,
      fetched_at: now,
      expires_at: expiresAt,
    }));

  // Upsert catalog rows (idempotent on tcgapis_sku_id)
  if (skuRows.length) {
    const { error } = await supabaseAdmin
      .from("card_skus")
      .upsert(skuRows, { onConflict: "tcgapis_sku_id" });
    if (error) {
      await logError({
        source: "sku-sync-catalog-upsert",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { cardId, productId },
      });
    }
  }

  // Upsert price rows
  if (priceRows.length) {
    const { error } = await supabaseAdmin
      .from("sku_prices")
      .upsert(priceRows, { onConflict: "tcgapis_sku_id" });
    if (error) {
      await logError({
        source: "sku-sync-price-upsert",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { cardId, productId },
      });
    }
  }

  return { skus: skuRows.length, prices: priceRows.length };
};

// ─── Sync SKUs for one set (catalog + prices) ─────────────────────────────────

export const syncSkusForSet = async (
  setId: string,
): Promise<{ cards: number; skus: number; prices: number; failed: number }> => {
  const { data: logRow } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "skus", status: "running" })
    .select("id")
    .single();
  const logId = logRow?.id;

  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("id, tcgapis_product_id")
    .eq("set_id", setId)
    .not("tcgapis_product_id", "is", null);

  let cardsProcessed = 0;
  let totalSkus = 0;
  let totalPrices = 0;
  let failed = 0;

  for (const card of cards ?? []) {
    await sleep(60); // ~1000/min, well under the 2000/min Unlimited ceiling
    try {
      const r = await syncSkusForProduct(card.id, card.tcgapis_product_id!);
      totalSkus += r.skus;
      totalPrices += r.prices;
      cardsProcessed++;
    } catch (err: any) {
      failed++;
      console.error(
        `[SKU-SYNC] product ${card.tcgapis_product_id} failed:`,
        err?.message,
      );
    }
  }

  if (logId) {
    await supabaseAdmin
      .from("price_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        total_items: (cards ?? []).length,
        synced_items: cardsProcessed,
        failed_items: failed,
        status: failed > 0 && cardsProcessed === 0 ? "failed" : "completed",
      })
      .eq("id", logId);
  }

  return {
    cards: cardsProcessed,
    skus: totalSkus,
    prices: totalPrices,
    failed,
  };
};

// ─── Price-only refresh for one set (nightly hot path) ────────────────────────
// Skips catalog upsert — only re-fetches sku_prices. Faster.

export const refreshSkuPricesForSet = async (
  setId: string,
): Promise<{ prices: number; failed: number }> => {
  // Use the SKUs we already know about for this set
  const { data: skuRows } = await supabaseAdmin
    .from("card_skus")
    .select("tcgapis_product_id")
    .eq(
      "card_id",
      // subquery-ish: we can't join easily here, so fetch products via cards
      // Instead, pull distinct product IDs from cards for this set:
      "",
    );

  // Simpler + reliable: pull product IDs from cards in this set
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("id, tcgapis_product_id")
    .eq("set_id", setId)
    .not("tcgapis_product_id", "is", null);

  let prices = 0;
  let failed = 0;

  for (const card of cards ?? []) {
    await sleep(60);
    try {
      const r = await syncSkusForProduct(card.id, card.tcgapis_product_id!);
      prices += r.prices;
    } catch (err: any) {
      failed++;
      console.error(
        `[SKU-SYNC] refresh product ${card.tcgapis_product_id} failed:`,
        err?.message,
      );
    }
  }

  void skuRows; // (kept to document the alternative path; cards-based is used)
  return { prices, failed };
};

// ─── Refresh all SKU prices (nightly cron entry point) ────────────────────────

export const refreshAllSkuPrices = async (): Promise<{
  setsProcessed: number;
  totalPrices: number;
  totalFailed: number;
}> => {
  const { data: logRow } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "prices", status: "running" })
    .select("id")
    .single();
  const logId = logRow?.id;

  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .not("tcgapis_group_id", "is", null)
    .order("release_date", { ascending: false });

  let setsProcessed = 0;
  let totalPrices = 0;
  let totalFailed = 0;

  for (const set of sets ?? []) {
    try {
      const r = await refreshSkuPricesForSet(set.id);
      totalPrices += r.prices;
      totalFailed += r.failed;
      setsProcessed++;
      await sleep(200);
    } catch (err: any) {
      totalFailed++;
      await logError({
        source: "sku-refresh-all",
        message: err?.message ?? "set refresh failed",
        error: err,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId: set.id },
      });
    }
  }

  if (logId) {
    await supabaseAdmin
      .from("price_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        total_items: (sets ?? []).length,
        synced_items: setsProcessed,
        failed_items: totalFailed,
        status: "completed",
      })
      .eq("id", logId);
  }

  return { setsProcessed, totalPrices, totalFailed };
};

// ─── Full SKU catalog + price sync (run once, or weekly) ──────────────────────

export const syncAllSkus = async (): Promise<{
  setsProcessed: number;
  totalSkus: number;
  totalPrices: number;
}> => {
  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .not("tcgapis_group_id", "is", null)
    .order("release_date", { ascending: false });

  let setsProcessed = 0;
  let totalSkus = 0;
  let totalPrices = 0;

  for (const set of sets ?? []) {
    try {
      const r = await syncSkusForSet(set.id);
      totalSkus += r.skus;
      totalPrices += r.prices;
      setsProcessed++;
      await sleep(300);
    } catch (err: any) {
      console.error(`[SKU-SYNC] set ${set.name} failed:`, err?.message);
    }
  }

  return { setsProcessed, totalSkus, totalPrices };
};

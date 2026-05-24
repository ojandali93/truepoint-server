// src/services/variantPriceSync.service.ts
// NM-per-variant pricing from TCGAPIs — the simple, correct path.
//
// TCGPlayer's `marketPrice` IS the Near Mint price by convention, so per
// variant (Normal / Holofoil / Reverse Holofoil / ...) we store the NM
// market price. No condition breakdown, no SKUs — exactly what the Pokemon
// market actually trades on.
//
// Native keyspace: cards.id == tcgapis_product_id, so NO name/number matching.
// We read cards by set, call /api/v2/prices/{productId}, and upsert:
//   • card_variants  — the variant list for the UI (label/color/sort)
//   • market_prices  — NM market price per variant (source 'tcgplayer')
//
// Writes a price_sync_log row so you can track progress + failures.

import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";
import { tcgapisGet, resolveVariant, sleep } from "../lib/tcgapisClient";

const PRICE_TTL_MS = 48 * 60 * 60 * 1000; // 48h — survives one missed nightly run

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

// ─── One card: fetch prices, upsert variants + market_prices ──────────────────

const syncCardPrices = async (
  cardId: string,
  productId: number,
  setId: string,
): Promise<{ variants: number; prices: number }> => {
  const res = await tcgapisGet<TCGPricesResponse>(
    `/api/v2/prices/${productId}`,
  );
  const pricesObj = res.data?.prices ?? {};

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PRICE_TTL_MS).toISOString();

  const variantRows: any[] = [];
  const priceRows: any[] = [];

  for (const [variantName, p] of Object.entries(pricesObj)) {
    const variantDef = resolveVariant(variantName);

    // Always record the variant exists (even if price is currently null) so the
    // UI variant selector is complete. Skip fully-empty TCGPlayer slots though —
    // e.g. "1st Edition Holofoil" on a modern card is always null and noise.
    const hasAnyPrice =
      p &&
      (p.marketPrice != null ||
        p.lowPrice != null ||
        p.midPrice != null ||
        p.highPrice != null);
    if (!hasAnyPrice) continue;

    variantRows.push({
      card_id: cardId,
      set_id: setId,
      variant_type: variantDef.type,
      label: variantDef.label,
      color: variantDef.color,
      sort_order: variantDef.sortOrder,
    });

    priceRows.push({
      card_id: cardId,
      source: "tcgplayer",
      variant: variantDef.type,
      grade: null,
      low_price: p!.lowPrice ?? null,
      mid_price: p!.midPrice ?? null,
      high_price: p!.highPrice ?? null,
      market_price: p!.marketPrice ?? null, // ← NM price
      fetched_at: now,
      expires_at: expiresAt,
    });
  }

  if (variantRows.length) {
    const { error } = await supabaseAdmin
      .from("card_variants")
      .upsert(variantRows, { onConflict: "card_id,variant_type" });
    if (error)
      await logError({
        source: "variant-price-sync-variants",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { cardId, productId },
      });
  }

  if (priceRows.length) {
    const { error } = await supabaseAdmin
      .from("market_prices")
      .upsert(priceRows, { onConflict: "card_id,source,variant,grade" });
    if (error)
      await logError({
        source: "variant-price-sync-prices",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { cardId, productId },
      });
  }

  return { variants: variantRows.length, prices: priceRows.length };
};

// ─── One set ──────────────────────────────────────────────────────────────────

export const syncVariantPricesForSet = async (
  setId: string,
): Promise<{
  cards: number;
  variants: number;
  prices: number;
  failed: number;
}> => {
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("id, tcgapis_product_id")
    .eq("set_id", setId)
    .not("tcgapis_product_id", "is", null);

  let cardsProcessed = 0;
  let totalVariants = 0;
  let totalPrices = 0;
  let failed = 0;

  for (const card of cards ?? []) {
    await sleep(60); // ~1000/min, half the 2000/min ceiling
    try {
      const r = await syncCardPrices(card.id, card.tcgapis_product_id!, setId);
      totalVariants += r.variants;
      totalPrices += r.prices;
      cardsProcessed++;
    } catch (err: any) {
      failed++;
      console.error(
        `[VariantPrice] product ${card.tcgapis_product_id} failed:`,
        err?.message,
      );
    }
  }

  return {
    cards: cardsProcessed,
    variants: totalVariants,
    prices: totalPrices,
    failed,
  };
};

// ─── All sets (initial populate + nightly refresh) ────────────────────────────

export const syncAllVariantPrices = async (): Promise<{
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
      const r = await syncVariantPricesForSet(set.id);
      totalPrices += r.prices;
      totalFailed += r.failed;
      setsProcessed++;
      await sleep(200);
    } catch (err: any) {
      totalFailed++;
      await logError({
        source: "variant-price-sync-all",
        message: err?.message ?? "set price sync failed",
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

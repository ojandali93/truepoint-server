// src/services/productPriceSync.service.ts
// NM market price for SEALED PRODUCTS.
//
// Products are already in the `products` table (split out during catalog sync),
// keyed natively: products.id == TCGPlayer productId. So we DON'T re-scan the
// cards endpoint — we read the products table directly and price each one via
// /api/v2/prices/{productId}, writing NM market price to product_price_cache.
//
// Same proven pattern as the card variant price sync, just pointed at products.
// Products typically have ONE pricing slot ("Normal"/"Unopened"), so we take the
// best available market price across whatever the response returns.

import { logError } from "../lib/Logger";
import { supabaseAdmin } from "../lib/supabase";
import { tcgapisGet, sleep } from "../lib/tcgapisClient";

const PRICE_TTL_MS = 48 * 60 * 60 * 1000; // 48h — survives a missed nightly run

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

const num = (v: any): number | null =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

// Pick the best price slot from a product's prices object.
// Products usually have one slot; if multiple, prefer the one with a
// marketPrice, then the highest market (the "main" SKU).
const pickBestPrice = (
  prices: Record<string, TCGPriceData>,
): TCGPriceData | null => {
  const slots = Object.values(prices ?? {}).filter(
    (p) =>
      p &&
      (num(p.marketPrice) != null ||
        num(p.lowPrice) != null ||
        num(p.midPrice) != null),
  );
  if (!slots.length) return null;
  slots.sort((a, b) => (num(b.marketPrice) ?? 0) - (num(a.marketPrice) ?? 0));
  return slots[0];
};

// ─── One product ──────────────────────────────────────────────────────────────

const syncOneProductPrice = async (productId: string): Promise<boolean> => {
  const res = await tcgapisGet<TCGPricesResponse>(
    `/api/v2/prices/${productId}`,
  );
  const best = pickBestPrice(res.data?.prices ?? {});
  if (!best) return false;

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + PRICE_TTL_MS).toISOString();

  const { error } = await supabaseAdmin.from("product_price_cache").upsert(
    {
      product_id: productId,
      source: "tcgplayer",
      low_price: num(best.lowPrice),
      mid_price: num(best.midPrice),
      high_price: num(best.highPrice),
      market_price: num(best.marketPrice), // ← NM price
      fetched_at: now,
      expires_at: expiresAt,
    },
    { onConflict: "product_id,source" },
  );

  if (error) {
    await logError({
      source: "product-price-sync",
      message: error.message,
      error,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: { productId },
    });
    return false;
  }
  return true;
};

// ─── One set's products ───────────────────────────────────────────────────────

export const syncProductPricesForSet = async (
  setId: string,
): Promise<{ products: number; priced: number; failed: number }> => {
  const { data: products } = await supabaseAdmin
    .from("products")
    .select("id")
    .eq("set_id", setId);

  let priced = 0;
  let failed = 0;

  for (const product of products ?? []) {
    await sleep(60); // ~1000/min, under the 2000/min ceiling
    try {
      const ok = await syncOneProductPrice(product.id);
      if (ok) priced++;
    } catch (err: any) {
      failed++;
      console.error(
        `[ProductPrice] product ${product.id} failed:`,
        err?.message,
      );
    }
  }

  return { products: (products ?? []).length, priced, failed };
};

// ─── All products (initial populate + nightly refresh) ────────────────────────

export const syncAllProductPrices = async (): Promise<{
  total: number;
  priced: number;
  failed: number;
}> => {
  const { data: logRow } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "products", status: "running" })
    .select("id")
    .single();
  const logId = logRow?.id;

  // Page through ALL products (there are ~2,800; PostgREST caps at 1000/req)
  const allProducts: Array<{ id: string }> = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const { data, error } = await supabaseAdmin
      .from("products")
      .select("id")
      .range(from, from + PAGE - 1);
    if (error) break;
    allProducts.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }

  let priced = 0;
  let failed = 0;

  for (const product of allProducts) {
    await sleep(60);
    try {
      const ok = await syncOneProductPrice(product.id);
      if (ok) priced++;
    } catch (err: any) {
      failed++;
      console.error(
        `[ProductPrice] product ${product.id} failed:`,
        err?.message,
      );
    }
  }

  if (logId) {
    await supabaseAdmin
      .from("price_sync_log")
      .update({
        completed_at: new Date().toISOString(),
        total_items: allProducts.length,
        synced_items: priced,
        failed_items: failed,
        status: "completed",
      })
      .eq("id", logId);
  }

  return { total: allProducts.length, priced, failed };
};

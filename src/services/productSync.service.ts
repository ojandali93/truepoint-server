import { supabaseAdmin } from "../lib/supabase";
import { cardMarketClient } from "../lib/cardMarketClient";

const PRICE_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours

export const syncProductsForSet = async (setId: string): Promise<number> => {
  console.log(`[ProductSync] Fetching sealed products for set: ${setId}`);

  try {
    const products = await cardMarketClient.getSealedProducts(setId);
    if (!products.length) {
      console.log(`[ProductSync] No products found for set: ${setId}`);
      return 0;
    }

    const expiresAt = new Date(Date.now() + PRICE_TTL_MS).toISOString();

    for (const product of products) {
      const productId = `${setId}-${product.id}`;

      // Upsert product metadata
      await supabaseAdmin.from("products").upsert(
        {
          id: productId,
          name: product.name,
          set_id: setId,
          product_type: normalizeProductType(product.type),
          image_url: null,
          synced_at: new Date().toISOString(),
        },
        { onConflict: "id" },
      );

      // Upsert prices
      const priceRows = [];

      if (product.prices?.tcg_player?.market_price) {
        priceRows.push({
          product_id: productId,
          source: "tcgplayer",
          low_price: null,
          mid_price: null,
          high_price: null,
          market_price: product.prices.tcg_player.market_price,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
        });
      }

      if (product.prices?.cardmarket?.trend_price) {
        priceRows.push({
          product_id: productId,
          source: "cardmarket",
          low_price: null,
          mid_price: product.prices.cardmarket.avg30 ?? null,
          high_price: null,
          market_price: product.prices.cardmarket.trend_price,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
        });
      }

      if (product.prices?.ebay?.median_price) {
        priceRows.push({
          product_id: productId,
          source: "ebay",
          low_price: null,
          mid_price: null,
          high_price: null,
          market_price: product.prices.ebay.median_price,
          fetched_at: new Date().toISOString(),
          expires_at: expiresAt,
        });
      }

      if (priceRows.length > 0) {
        await supabaseAdmin
          .from("product_price_cache")
          .upsert(priceRows, { onConflict: "product_id,source" });
      }
    }

    return products.length;
  } catch (err: any) {
    console.error(`[ProductSync] Failed for set ${setId}:`, err?.message);
    return 0;
  }
};

export const syncAllProducts = async (): Promise<void> => {
  console.log("[ProductSync] Starting full product sync...");

  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .order("release_date", { ascending: false });

  if (!sets?.length) return;

  let totalSynced = 0;

  for (const set of sets) {
    const count = await syncProductsForSet(set.id);
    totalSynced += count;
    await new Promise((res) => setTimeout(res, 500)); // polite delay
  }

  console.log(`[ProductSync] Complete. Total products synced: ${totalSynced}`);
};

const normalizeProductType = (type: string): string => {
  const t = type.toLowerCase();
  if (t.includes("booster box") || t.includes("booster_box"))
    return "booster_box";
  if (t.includes("elite trainer") || t.includes("etb"))
    return "elite_trainer_box";
  if (t.includes("ultra premium") || t.includes("upc"))
    return "ultra_premium_collection";
  if (t.includes("special collection") || t.includes("spc"))
    return "special_collection";
  if (t.includes("bundle")) return "bundle";
  if (t.includes("tin")) return "tin";
  if (t.includes("blister")) return "blister";
  if (t.includes("promo")) return "promo_pack";
  return "collection";
};

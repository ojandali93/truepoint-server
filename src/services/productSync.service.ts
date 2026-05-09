import { supabaseAdmin } from "../lib/supabase";
import { cardMarketClient, CardMarketExpansion } from "../lib/cardMarketClient";

const PRICE_TTL_MS = 48 * 60 * 60 * 1000;
const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ─── Expansion cache ──────────────────────────────────────────────────────────
// Fetch all CardMarket expansions once and reuse across the sync

let expansionCache: CardMarketExpansion[] | null = null;

const getExpansions = async (): Promise<CardMarketExpansion[]> => {
  if (expansionCache) return expansionCache;
  console.log("[ProductSync] Fetching all CardMarket expansions...");
  expansionCache = await cardMarketClient.getAllExpansions();
  console.log(`[ProductSync] Found ${expansionCache.length} expansions`);
  return expansionCache;
};

// Match a set from your DB to a CardMarket expansion
// Tries: exact name match, then code match, then fuzzy name match
const findExpansion = (
  setName: string,
  setId: string,
  expansions: CardMarketExpansion[],
): CardMarketExpansion | null => {
  // Normalize for comparison
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  const normalizedSetName = normalize(setName);

  // 1. Exact name match
  let match = expansions.find((e) => normalize(e.name) === normalizedSetName);
  if (match) return match;

  // 2. Code match (CardMarket uses codes like CRZ, SVI, OBF)
  // pokemontcg.io uses sv1, sv2, swsh1 etc — try mapping the suffix
  match = expansions.find((e) => e.code.toLowerCase() === setId.toLowerCase());
  if (match) return match;

  // 3. Partial name match (handles subtitle differences)
  match = expansions.find(
    (e) =>
      normalize(e.name).includes(normalizedSetName) ||
      normalizedSetName.includes(normalize(e.name)),
  );
  if (match) return match;

  return null;
};

// ─── Sync a single set ───────────────────────────────────────────────────────

export const syncProductsForSet = async (
  setId: string,
  setName: string,
): Promise<number> => {
  const expansions = await getExpansions();
  const expansion = findExpansion(setName, setId, expansions);

  if (!expansion) {
    console.log(
      `[ProductSync] No CardMarket expansion match for: ${setName} (${setId})`,
    );
    return 0;
  }

  console.log(
    `[ProductSync] Matched "${setName}" → CardMarket: "${expansion.name}" (id: ${expansion.id})`,
  );

  try {
    const products = await cardMarketClient.getProductsByExpansion(
      expansion.id,
    );
    console.log(
      `[ProductSync] Found ${products.length} products for ${setName}`,
    );

    if (!products.length) return 0;

    const expiresAt = new Date(Date.now() + PRICE_TTL_MS).toISOString();
    let saved = 0;

    for (const product of products) {
      const productId = `${setId}-${product.id}`;

      const { error: productError } = await supabaseAdmin
        .from("products")
        .upsert(
          {
            id: productId,
            name: product.name,
            set_id: setId,
            product_type: normalizeProductType(product.name),
            image_url: product.image ?? null,
            synced_at: new Date().toISOString(),
          },
          { onConflict: "id" },
        );

      if (productError) {
        console.error(
          `[ProductSync] Failed to save product ${productId}:`,
          productError.message,
        );
        continue;
      }

      // Save CardMarket price
      const cmPrice = product.prices?.cardmarket;
      const cmLow = cmPrice?.lowest_near_mint ?? null;
      if (cmLow != null) {
        await supabaseAdmin.from("product_price_cache").upsert(
          {
            product_id: productId,
            source: "cardmarket",
            low_price: cmLow,
            mid_price: null,
            high_price: null,
            market_price: cmLow,
            fetched_at: new Date().toISOString(),
            expires_at: expiresAt,
          },
          { onConflict: "product_id,source" },
        );
      }

      saved++;
    }

    console.log(
      `[ProductSync] ✓ ${setName}: saved ${saved}/${products.length} products`,
    );
    return saved;
  } catch (err: any) {
    console.error(
      `[ProductSync] Failed for ${setName} (${setId}):`,
      err?.message,
    );
    return 0;
  }
};

// ─── Sync all sets ────────────────────────────────────────────────────────────

export const syncAllProducts = async (): Promise<void> => {
  console.log("[ProductSync] Starting full product sync...");

  // Pre-fetch expansions once
  await getExpansions();

  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .order("release_date", { ascending: false });

  if (!sets?.length) {
    console.log("[ProductSync] No sets found in database");
    return;
  }

  let totalProducts = 0;
  let matchedSets = 0;

  for (const set of sets) {
    const count = await syncProductsForSet(set.id, set.name);
    if (count > 0) {
      totalProducts += count;
      matchedSets++;
    }
    await delay(2000); // 2s between sets — well within rate limits
  }

  console.log(
    `[ProductSync] Complete. ${matchedSets} sets matched, ${totalProducts} products saved`,
  );

  // Clear expansion cache for next run
  expansionCache = null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const normalizeProductType = (name: string): string => {
  const n = name.toLowerCase();
  if (n.includes("ultra premium") || n.includes("upc"))
    return "ultra_premium_collection";
  if (n.includes("special collection") || n.includes("spc"))
    return "special_collection";
  if (n.includes("elite trainer") || n.includes("etb"))
    return "elite_trainer_box";
  if (n.includes("booster box") || n.includes("booster bundle"))
    return "booster_box";
  if (n.includes("collection box") || n.includes("collector"))
    return "collection";
  if (n.includes("bundle")) return "bundle";
  if (n.includes("blister")) return "blister";
  if (n.includes("tin")) return "tin";
  if (n.includes("promo")) return "promo_pack";
  if (n.includes("booster")) return "booster_box";
  return "collection";
};

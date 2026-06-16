// src/services/catalogSync.service.ts
// TCGAPIs-NATIVE catalog sync.
//
// Since the catalog was purged, TCGAPIs is now the native keyspace:
//   sets.id  = String(groupId)      sets.tcgapis_group_id   = groupId
//   cards.id = String(productId)    cards.tcgapis_product_id = productId
//
// No name/number matching needed — every set/card is inserted with its real
// TCGAPIs ID. The entire pricing pipeline (tcgapisSync variants, tcgapisSkuSync,
// tcgapisProductSync) works unchanged because it reads tcgapis_product_id,
// which now equals the id.
//
// LANGUAGE: we ingest two TCGPlayer categories — English Pokémon (3) and
// Pokemon Japan (85). groupId/productId are globally unique across categories,
// so EN and JP never collide. Each set/card/product is stamped with `language`
// ("English" | "Japanese") so the app can filter/badge. Requires columns:
//   sets.language text not null default 'English'
//   cards.language text
//   products.language text
//
// pokemontcg.io is the FALLBACK only for game metadata TCGAPIs doesn't return
// (supertype, subtypes, hp, types) — see pokemontcgFallback.service.ts. Note it
// is English-only, so Japanese cards won't get those fields backfilled.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import {
  tcgapisGet,
  POKEMON_CATEGORY_ID,
  POKEMON_JP_CATEGORY_ID,
  sleep,
} from "../lib/tcgapisClient";

// ─── TCGAPIs response types ───────────────────────────────────────────────────

interface TCGExpansion {
  groupId: number;
  name: string;
  abbreviation?: string;
  publishedOn?: string;
}
interface TCGExpansionsResponse {
  success: boolean;
  count: number;
  total: number;
  data: TCGExpansion[];
}
interface TCGCard {
  productId: number;
  name: string;
  cleanName?: string;
  image?: string;
  rarity?: string;
  number?: string;
}
interface TCGCardsResponse {
  success: boolean;
  count: number;
  total: number;
  data: TCGCard[];
}

// ─── Sealed-product classification ────────────────────────────────────────────
// TCGAPIs returns sealed products mixed into the cards endpoint, flagged by
// rarity === 'sealed'. We route those to the `products` table and map each to
// one of the products.product_type enum values by name.

const isSealed = (c: TCGCard): boolean =>
  (c.rarity ?? "").toLowerCase() === "sealed";

// Maps a sealed product name to a products.product_type enum value.
// Enum: booster_box | elite_trainer_box | bundle | tin | collection |
//       blister | promo_pack | ultra_premium_collection | special_collection
const PRODUCT_TYPE_RULES: Array<[RegExp, string]> = [
  [/elite trainer box/i, "elite_trainer_box"],
  [/booster box/i, "booster_box"],
  [/ultra premium/i, "ultra_premium_collection"],
  [/premium collection/i, "special_collection"],
  [/build ?& ?battle|build and battle/i, "bundle"],
  [/bundle/i, "bundle"],
  [/blister/i, "blister"],
  [/\btin\b/i, "tin"],
  [/booster pack/i, "blister"], // single/loose packs — closest enum
  [/promo/i, "promo_pack"],
  [/collection/i, "collection"],
];

const inferProductType = (name: string): string => {
  for (const [re, type] of PRODUCT_TYPE_RULES) if (re.test(name)) return type;
  return "collection"; // safe default — always a valid enum value
};

// ═══════════════════════════════════════════════════════════════════════════
// SETS — native (groupId = id), across English + Japanese categories
// ═══════════════════════════════════════════════════════════════════════════

const POKEMON_CATEGORIES: { categoryId: number; language: string }[] = [
  { categoryId: POKEMON_CATEGORY_ID, language: "English" }, // 3
  { categoryId: POKEMON_JP_CATEGORY_ID, language: "Japanese" }, // 85
];

export const syncSets = async (): Promise<{ synced: number }> => {
  // Pull expansions for each category, tagging every one with its language.
  const expansions: Array<TCGExpansion & { language: string }> = [];

  for (const cat of POKEMON_CATEGORIES) {
    let offset = 0;
    let pulled = 0; // per-category counter (total is per-category)
    while (true) {
      await sleep(200);
      const data = await tcgapisGet<TCGExpansionsResponse>(
        `/api/v2/expansions/${cat.categoryId}`,
        { limit: 100, offset },
      );
      const batch = data.data ?? [];
      expansions.push(...batch.map((e) => ({ ...e, language: cat.language })));
      pulled += batch.length;
      if (pulled >= data.total || batch.length < 100) break;
      offset += 100;
    }
  }

  if (!expansions.length) {
    throw new Error("No expansions returned from TCGAPIs");
  }

  const rows = expansions.map((exp) => ({
    id: String(exp.groupId),
    name: exp.name,
    series: null as string | null, // TCGAPIs doesn't provide series; pokemontcg fallback can fill
    release_date: exp.publishedOn ? exp.publishedOn.slice(0, 10) : null,
    tcgapis_group_id: exp.groupId,
    language: exp.language,
    synced_at: new Date().toISOString(),
  }));

  // Upsert in chunks (PostgREST limits payload size)
  let synced = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from("sets")
      .upsert(chunk, { onConflict: "id" });
    if (error) {
      await logError({
        source: "catalog-sync-sets",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { chunkStart: i },
      });
    } else {
      synced += chunk.length;
    }
  }

  return { synced };
};

// ═══════════════════════════════════════════════════════════════════════════
// CARDS — native (productId = id), per set
// ═══════════════════════════════════════════════════════════════════════════

export const syncCardsForSet = async (
  setId: string,
): Promise<{ cards: number; products: number }> => {
  const { data: set } = await supabaseAdmin
    .from("sets")
    .select("id, tcgapis_group_id, language")
    .eq("id", setId)
    .single();

  if (!set?.tcgapis_group_id) return { cards: 0, products: 0 };

  // Inherit the set's language so cards/products carry it too (default English
  // for any legacy set row that predates the language column).
  const language = (set.language as string | null) ?? "English";

  const apiItems: TCGCard[] = [];
  let offset = 0;
  while (true) {
    await sleep(150);
    const data = await tcgapisGet<TCGCardsResponse>(
      `/api/v2/cards/${set.tcgapis_group_id}`,
      { limit: 100, offset },
    );
    apiItems.push(...(data.data ?? []));
    if (apiItems.length >= data.total || (data.data?.length ?? 0) < 100) break;
    offset += 100;
  }

  if (!apiItems.length) return { cards: 0, products: 0 };

  const now = new Date().toISOString();

  // Split: sealed → products table, everything else → cards table
  const sealedItems = apiItems.filter(isSealed);
  const cardItems = apiItems.filter((c) => !isSealed(c));

  // ── Cards ──
  const cardRows = cardItems.map((c) => ({
    id: String(c.productId),
    name: c.name,
    number: c.number ?? "",
    rarity: c.rarity ?? null,
    set_id: setId,
    image_small: c.image ?? null,
    image_large: c.image ?? null,
    tcgapis_product_id: c.productId,
    catalog_source: "tcgapis",
    language,
    synced_at: now,
  }));

  let cardsSynced = 0;
  for (let i = 0; i < cardRows.length; i += 100) {
    const chunk = cardRows.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from("cards")
      .upsert(chunk, { onConflict: "id" });
    if (error) {
      await logError({
        source: "catalog-sync-cards",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId, chunkStart: i },
      });
    } else {
      cardsSynced += chunk.length;
    }
  }

  // ── Products (sealed) ──
  const productRows = sealedItems.map((c) => ({
    id: String(c.productId),
    name: c.name,
    set_id: setId,
    product_type: inferProductType(c.name),
    image_url: c.image ?? null,
    language,
    synced_at: now,
  }));

  let productsSynced = 0;
  for (let i = 0; i < productRows.length; i += 100) {
    const chunk = productRows.slice(i, i + 100);
    const { error } = await supabaseAdmin
      .from("products")
      .upsert(chunk, { onConflict: "id" });
    if (error) {
      await logError({
        source: "catalog-sync-products",
        message: error.message,
        error,
        userId: null,
        requestPath: "",
        requestMethod: "",
        metadata: { setId, chunkStart: i },
      });
    } else {
      productsSynced += chunk.length;
    }
  }

  return { cards: cardsSynced, products: productsSynced };
};

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION — full catalog (sets + all cards)
// ═══════════════════════════════════════════════════════════════════════════

export const syncFullCatalog = async (): Promise<{
  sets: number;
  setsProcessed: number;
  cards: number;
  products: number;
}> => {
  const { data: logRow } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "catalog", status: "running" })
    .select("id")
    .single();
  const logId = logRow?.id;

  // 1. Sets (English + Japanese)
  const { synced: setsSynced } = await syncSets();
  await sleep(1000);

  // 2. Cards + sealed products per set (every set with a tcgapis_group_id,
  //    which now includes Japanese sets automatically).
  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id")
    .not("tcgapis_group_id", "is", null)
    .order("release_date", { ascending: false });

  let setsProcessed = 0;
  let totalCards = 0;
  let totalProducts = 0;

  for (const set of sets ?? []) {
    try {
      const r = await syncCardsForSet(set.id);
      totalCards += r.cards;
      totalProducts += r.products;
      setsProcessed++;
      await sleep(300);
    } catch (err: any) {
      await logError({
        source: "catalog-sync-set",
        message: err?.message ?? "set card sync failed",
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
        status: "completed",
      })
      .eq("id", logId);
  }

  return {
    sets: setsSynced,
    setsProcessed,
    cards: totalCards,
    products: totalProducts,
  };
};

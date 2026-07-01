// src/services/catalogSync.service.ts
// TCGAPIs-NATIVE catalog sync.
//
//   sets.id  = String(groupId)      sets.tcgapis_group_id   = groupId
//   cards.id = String(productId)    cards.tcgapis_product_id = productId
//
// LANGUAGE: ingests English Pokémon (category 3) + Pokemon Japan (category 85).
// Each set/card/product is stamped with `language`.
//
// ROBUST UPSERT: rows are upserted in batches, but a Postgres array upsert is a
// SINGLE statement — one bad row fails the WHOLE batch. Previously a failed
// batch was logged-and-skipped, silently losing up to 100 cards (which shows up
// as scattered missing collector numbers, since cards arrive in productId order,
// not number order). Now a failed batch is retried row-by-row so only the
// offending row is skipped — and that row is logged with its id/name/number/
// rarity, making the real constraint violation obvious in Error Logs.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import {
  tcgapisGet,
  POKEMON_CATEGORY_ID,
  POKEMON_JP_CATEGORY_ID,
  ONE_PIECE_CATEGORY_ID,
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

const isSealed = (c: TCGCard): boolean =>
  (c.rarity ?? "").toLowerCase() === "sealed";

const PRODUCT_TYPE_RULES: Array<[RegExp, string]> = [
  [/elite trainer box/i, "elite_trainer_box"],
  [/booster box/i, "booster_box"],
  [/ultra premium/i, "ultra_premium_collection"],
  [/premium collection/i, "special_collection"],
  [/build ?& ?battle|build and battle/i, "bundle"],
  [/bundle/i, "bundle"],
  [/blister/i, "blister"],
  [/\btin\b/i, "tin"],
  [/booster pack/i, "blister"],
  [/promo/i, "promo_pack"],
  [/collection/i, "collection"],
];

const inferProductType = (name: string): string => {
  for (const [re, type] of PRODUCT_TYPE_RULES) if (re.test(name)) return type;
  return "collection";
};

// ═══════════════════════════════════════════════════════════════════════════
// ROBUST UPSERT — batch first, then row-by-row on failure
// ═══════════════════════════════════════════════════════════════════════════

interface UpsertRow {
  id: string;
  name?: string;
  number?: string;
  rarity?: string | null;
  [k: string]: unknown;
}

const upsertRows = async (
  table: "sets" | "cards" | "products",
  rows: UpsertRow[],
  source: string,
  setId: string | null,
): Promise<number> => {
  let synced = 0;

  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);

    const { error } = await supabaseAdmin
      .from(table)
      .upsert(chunk, { onConflict: "id" });

    if (!error) {
      synced += chunk.length;
      continue;
    }

    // Batch failed — almost always one bad row. Retry individually so the rest
    // of the batch still lands, and log the exact offender(s).
    for (const row of chunk) {
      const { error: rowErr } = await supabaseAdmin
        .from(table)
        .upsert(row, { onConflict: "id" });

      if (rowErr) {
        await logError({
          source,
          message: `Row upsert failed: ${rowErr.message}`,
          error: rowErr,
          userId: null,
          metadata: {
            setId,
            id: row.id,
            name: row.name ?? null,
            number: row.number ?? null,
            rarity: row.rarity ?? null,
          },
        });
      } else {
        synced += 1;
      }
    }
  }

  return synced;
};

// ═══════════════════════════════════════════════════════════════════════════
// SETS — native (groupId = id), across English + Japanese categories
// ═══════════════════════════════════════════════════════════════════════════

// Every catalog category we ingest, tagged with its game. One Piece is
// TCGAPIs/TCGplayer category 68 (English). Raw prices flow through the same
// product-ID-keyed price sync — no graded pricing for One Piece.
const CATEGORIES: { categoryId: number; language: string; game: string }[] = [
  { categoryId: POKEMON_CATEGORY_ID, language: "English", game: "pokemon" }, // 3
  { categoryId: POKEMON_JP_CATEGORY_ID, language: "Japanese", game: "pokemon" }, // 85
  { categoryId: ONE_PIECE_CATEGORY_ID, language: "English", game: "onepiece" }, // 68
];

export const syncSets = async (): Promise<{ synced: number }> => {
  const expansions: Array<TCGExpansion & { language: string; game: string }> =
    [];

  for (const cat of CATEGORIES) {
    let offset = 0;
    let pulled = 0;
    while (true) {
      await sleep(200);
      const data = await tcgapisGet<TCGExpansionsResponse>(
        `/api/v2/expansions/${cat.categoryId}`,
        { limit: 100, offset },
      );
      const batch = data.data ?? [];
      expansions.push(
        ...batch.map((e) => ({ ...e, language: cat.language, game: cat.game })),
      );
      pulled += batch.length;
      if (pulled >= data.total || batch.length < 100) break;
      offset += 100;
    }
  }

  if (!expansions.length) {
    throw new Error("No expansions returned from TCGAPIs");
  }

  const rows: UpsertRow[] = expansions.map((exp) => ({
    id: String(exp.groupId),
    name: exp.name,
    series: null as string | null,
    release_date: exp.publishedOn ? exp.publishedOn.slice(0, 10) : null,
    tcgapis_group_id: exp.groupId,
    language: exp.language,
    game: exp.game,
    synced_at: new Date().toISOString(),
  }));

  const synced = await upsertRows("sets", rows, "catalog-sync-sets", null);
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
    .select("id, tcgapis_group_id, language, game")
    .eq("id", setId)
    .single();

  if (!set?.tcgapis_group_id) return { cards: 0, products: 0 };

  const language = (set.language as string | null) ?? "English";
  const game = (set.game as string | null) ?? "pokemon";

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

  const sealedItems = apiItems.filter(isSealed);
  const cardItems = apiItems.filter((c) => !isSealed(c));

  // ── Cards ──
  const cardRows: UpsertRow[] = cardItems.map((c) => ({
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
    game,
    synced_at: now,
  }));

  const cardsSynced = await upsertRows(
    "cards",
    cardRows,
    "catalog-sync-cards",
    setId,
  );

  // ── Products (sealed) ──
  const productRows: UpsertRow[] = sealedItems.map((c) => ({
    id: String(c.productId),
    name: c.name,
    set_id: setId,
    product_type: inferProductType(c.name),
    image_url: c.image ?? null,
    language,
    game,
    synced_at: now,
  }));

  const productsSynced = await upsertRows(
    "products",
    productRows,
    "catalog-sync-products",
    setId,
  );

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

  const { synced: setsSynced } = await syncSets();
  await sleep(1000);

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

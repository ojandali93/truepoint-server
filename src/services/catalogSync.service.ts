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
// pokemontcg.io is the FALLBACK only for game metadata TCGAPIs doesn't return
// (supertype, subtypes, hp, types) — see pokemontcgFallback.service.ts.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { tcgapisGet, POKEMON_CATEGORY_ID, sleep } from "../lib/tcgapisClient";

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

// ═══════════════════════════════════════════════════════════════════════════
// SETS — native (groupId = id)
// ═══════════════════════════════════════════════════════════════════════════

export const syncSets = async (): Promise<{ synced: number }> => {
  const expansions: TCGExpansion[] = [];
  let offset = 0;
  while (true) {
    await sleep(200);
    const data = await tcgapisGet<TCGExpansionsResponse>(
      `/api/v2/expansions/${POKEMON_CATEGORY_ID}`,
      { limit: 100, offset },
    );
    expansions.push(...(data.data ?? []));
    if (expansions.length >= data.total || (data.data?.length ?? 0) < 100)
      break;
    offset += 100;
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
): Promise<{ cards: number }> => {
  const { data: set } = await supabaseAdmin
    .from("sets")
    .select("id, tcgapis_group_id")
    .eq("id", setId)
    .single();

  if (!set?.tcgapis_group_id) return { cards: 0 };

  const apiCards: TCGCard[] = [];
  let offset = 0;
  while (true) {
    await sleep(150);
    const data = await tcgapisGet<TCGCardsResponse>(
      `/api/v2/cards/${set.tcgapis_group_id}`,
      { limit: 100, offset },
    );
    apiCards.push(...(data.data ?? []));
    if (apiCards.length >= data.total || (data.data?.length ?? 0) < 100) break;
    offset += 100;
  }

  if (!apiCards.length) return { cards: 0 };

  const now = new Date().toISOString();
  const rows = apiCards.map((c) => ({
    id: String(c.productId),
    name: c.name,
    number: c.number ?? "",
    rarity: c.rarity ?? null,
    set_id: setId,
    image_small: c.image ?? null,
    image_large: c.image ?? null,
    tcgapis_product_id: c.productId,
    catalog_source: "tcgapis",
    synced_at: now,
  }));

  let synced = 0;
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
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
      synced += chunk.length;
    }
  }

  return { cards: synced };
};

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATION — full catalog (sets + all cards)
// ═══════════════════════════════════════════════════════════════════════════

export const syncFullCatalog = async (): Promise<{
  sets: number;
  setsProcessed: number;
  cards: number;
}> => {
  const { data: logRow } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "catalog", status: "running" })
    .select("id")
    .single();
  const logId = logRow?.id;

  // 1. Sets
  const { synced: setsSynced } = await syncSets();
  await sleep(1000);

  // 2. Cards per set
  const { data: sets } = await supabaseAdmin
    .from("sets")
    .select("id")
    .not("tcgapis_group_id", "is", null)
    .order("release_date", { ascending: false });

  let setsProcessed = 0;
  let totalCards = 0;

  for (const set of sets ?? []) {
    try {
      const r = await syncCardsForSet(set.id);
      totalCards += r.cards;
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

  return { sets: setsSynced, setsProcessed, cards: totalCards };
};

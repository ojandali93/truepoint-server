// src/repositories/csvImportCatalog.repository.ts
//
// Bulk, read-only catalog fetches for the CSV-import matcher
// (docs/csv-import-design.md). Deliberately separate from card.repository.ts
// / variant.repository.ts — those are shaped for single-card/single-set
// lookups (one card's variants, one set's cards); matching 522 rows needs
// whole-catalog and batched-by-set-id fetches instead, and mixing the two
// access patterns into the existing per-entity repositories would make
// their query shapes worse for their actual callers.
//
// Every query here reuses the same dead-row exclusion
// (`tcgapis_group_id IS NOT NULL`) that card.repository.ts's findAllSets()
// already established — verified during Phase 1 design that orphaned
// legacy `sets` rows with zero cards exist under names that collide with
// live ones (e.g. a dead "base2" "Jungle" next to the real one). Skipping
// this filter here would silently resolve some rows to a dead set.
//
// PAGINATION IS NOT OPTIONAL HERE (CLAUDE.md §8's documented PostgREST
// pitfall, hit for real building this): "One Piece Promotion Cards" alone
// has 2,236 cards — one `.in()` call covering that set silently truncates
// at PostgREST's 1000-row cap, which surfaced as ~90% of cards going
// "unmatched" on the very first harness run despite verified-correct set
// resolution. The three `...BySetIds`/`...ByCardIds` fetches below use the
// existing `fetchAllByIn()` (src/lib/pgFetchAll.ts) rather than a
// hand-rolled pager — it already solves exactly this (id-chunking + ordered
// `.range()` paging) and is what the codebase's other bulk fetches use;
// duplicating it here was a real mistake in an earlier version of this
// file, caught and reverted. fetchLiveSets isn't an `.in()` query at all
// (whole-game, not id-scoped), so it keeps its own small pager.

import { supabaseAdmin } from "../lib/supabase";
import { fetchAllByIn } from "../lib/pgFetchAll";
import { ImportGame } from "../types/csvImport.types";

export interface LiveSet {
  id: string;
  name: string;
  game: ImportGame;
  language: string | null;
}

export interface CatalogCard {
  id: string;
  name: string;
  number: string;
  rarity: string | null;
  setId: string;
}

export interface CatalogProduct {
  id: string;
  name: string;
  productType: string | null;
  setId: string;
}

export interface CatalogVariant {
  cardId: string;
  variantType: string;
  label: string;
}

const PAGE_SIZE = 1000; // PostgREST's hard per-response cap

export const fetchLiveSets = async (game: ImportGame): Promise<LiveSet[]> => {
  const out: LiveSet[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("sets")
      .select("id, name, game, language")
      .not("tcgapis_group_id", "is", null)
      .eq("game", game)
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = (data ?? []) as any[];
    out.push(
      ...batch.map((r) => ({
        id: String(r.id),
        name: r.name as string,
        game: r.game as ImportGame,
        language: (r.language as string) ?? null,
      })),
    );
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
};

export const fetchCardsBySetIds = async (
  setIds: string[],
): Promise<CatalogCard[]> => {
  const data = await fetchAllByIn<any>({
    table: "cards",
    columns: "id, name, number, rarity, set_id",
    column: "set_id",
    ids: setIds,
  });
  return data.map((r) => ({
    id: String(r.id),
    name: r.name as string,
    number: (r.number as string) ?? "",
    rarity: (r.rarity as string) ?? null,
    setId: String(r.set_id),
  }));
};

export const fetchProductsBySetIds = async (
  setIds: string[],
): Promise<CatalogProduct[]> => {
  const data = await fetchAllByIn<any>({
    table: "products",
    columns: "id, name, product_type, set_id",
    column: "set_id",
    ids: setIds,
  });
  return data.map((r) => ({
    id: String(r.id),
    name: r.name as string,
    productType: (r.product_type as string) ?? null,
    setId: String(r.set_id),
  }));
};

export const fetchCardVariantsByCardIds = async (
  cardIds: string[],
): Promise<CatalogVariant[]> => {
  const data = await fetchAllByIn<any>({
    table: "card_variants",
    columns: "card_id, variant_type, label",
    column: "card_id",
    ids: cardIds,
    orderColumn: "card_id",
  });
  return data.map((r) => ({
    cardId: String(r.card_id),
    variantType: r.variant_type as string,
    label: r.label as string,
  }));
};

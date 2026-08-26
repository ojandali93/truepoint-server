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
// pitfall, hit for real building this): PostgREST hard-caps any single
// response at 1000 rows with NO error, just a silent truncation.
// "One Piece Promotion Cards" alone has 2,236 cards — one `.in()` call
// covering that set (and any others in the same batch) will quietly drop
// everything past row 1000, which surfaced as ~90% of cards going
// "unmatched" on the very first harness run despite verified-correct set
// resolution. Every fetch below pages with `.range()` until a page comes
// back short.

import { supabaseAdmin } from "../lib/supabase";
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

const CHUNK_SIZE = 150; // ids per `.in()` filter — keeps the filter itself small
const PAGE_SIZE = 1000; // PostgREST's hard per-response cap

/** Pages a `.range()`-based query until a page comes back short of PAGE_SIZE. */
const fetchAllPages = async <T>(
  runPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> => {
  const out: T[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await runPage(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    const batch = data ?? [];
    out.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return out;
};

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export const fetchLiveSets = async (game: ImportGame): Promise<LiveSet[]> => {
  const data = await fetchAllPages<any>((from, to) =>
    supabaseAdmin
      .from("sets")
      .select("id, name, game, language")
      .not("tcgapis_group_id", "is", null)
      .eq("game", game)
      .order("id", { ascending: true })
      .range(from, to),
  );
  return data.map((r) => ({
    id: String(r.id),
    name: r.name as string,
    game: r.game as ImportGame,
    language: (r.language as string) ?? null,
  }));
};

export const fetchCardsBySetIds = async (
  setIds: string[],
): Promise<CatalogCard[]> => {
  if (setIds.length === 0) return [];
  const out: CatalogCard[] = [];
  for (const ids of chunk(setIds, CHUNK_SIZE)) {
    const data = await fetchAllPages<any>((from, to) =>
      supabaseAdmin
        .from("cards")
        .select("id, name, number, rarity, set_id")
        .in("set_id", ids)
        .order("id", { ascending: true })
        .range(from, to),
    );
    out.push(
      ...data.map((r) => ({
        id: String(r.id),
        name: r.name as string,
        number: (r.number as string) ?? "",
        rarity: (r.rarity as string) ?? null,
        setId: String(r.set_id),
      })),
    );
  }
  return out;
};

export const fetchProductsBySetIds = async (
  setIds: string[],
): Promise<CatalogProduct[]> => {
  if (setIds.length === 0) return [];
  const out: CatalogProduct[] = [];
  for (const ids of chunk(setIds, CHUNK_SIZE)) {
    const data = await fetchAllPages<any>((from, to) =>
      supabaseAdmin
        .from("products")
        .select("id, name, product_type, set_id")
        .in("set_id", ids)
        .order("id", { ascending: true })
        .range(from, to),
    );
    out.push(
      ...data.map((r) => ({
        id: String(r.id),
        name: r.name as string,
        productType: (r.product_type as string) ?? null,
        setId: String(r.set_id),
      })),
    );
  }
  return out;
};

export const fetchCardVariantsByCardIds = async (
  cardIds: string[],
): Promise<CatalogVariant[]> => {
  if (cardIds.length === 0) return [];
  const out: CatalogVariant[] = [];
  for (const ids of chunk(cardIds, CHUNK_SIZE)) {
    const data = await fetchAllPages<any>((from, to) =>
      supabaseAdmin
        .from("card_variants")
        .select("card_id, variant_type, label")
        .in("card_id", ids)
        .order("card_id", { ascending: true })
        .range(from, to),
    );
    out.push(
      ...data.map((r) => ({
        cardId: String(r.card_id),
        variantType: r.variant_type as string,
        label: r.label as string,
      })),
    );
  }
  return out;
};

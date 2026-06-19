// src/lib/pgFetchAll.ts
//
// PostgREST (Supabase) caps every response at a default of 1000 rows. Any
// query that does `.in("col", ids)` over a large set — e.g. fetching all
// price rows for an entire inventory in the "All collections" view — silently
// gets truncated to the first 1000 rows. Cards whose rows fall past the cap
// then resolve to no price ("—") and portfolio totals come out understated.
//
// fetchAllByIn() removes that ceiling with two layers:
//   1. ID chunking — the id list is split into batches so the request URL /
//      statement stays small even with thousands of ids.
//   2. Row paging — within each id-batch we page with .range() until a page
//      returns fewer than PAGE_SIZE rows. This is what actually defeats the
//      max-rows cap, since a single card can have dozens of price rows.
//
// Paging is ordered by a unique column (default "id") so pages never overlap
// or skip rows.

import { supabaseAdmin } from "./supabase";

interface FetchAllByInOptions {
  /** table name, e.g. "market_prices" */
  table: string;
  /** select() column list */
  columns: string;
  /** column used in the IN filter, e.g. "card_id" */
  column: string;
  /** values for the IN filter */
  ids: Array<string | number>;
  /** unique column to order by for stable paging (default "id") */
  orderColumn?: string;
  /** apply extra filters to each chunk query (e.g. q.gt("expires_at", now)) */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  modify?: (q: any) => any;
  /** ids per request batch (default 300) */
  idChunkSize?: number;
  /** rows per page within a batch (default 1000 = PostgREST cap) */
  pageSize?: number;
}

export async function fetchAllByIn<T = unknown>(
  opts: FetchAllByInOptions,
): Promise<T[]> {
  const {
    table,
    columns,
    column,
    ids,
    orderColumn = "id",
    modify,
    idChunkSize = 300,
    pageSize = 1000,
  } = opts;

  if (!ids.length) return [];

  // De-dupe defensively so chunk math is tight.
  const uniqueIds = [...new Set(ids)];
  const out: T[] = [];

  for (let i = 0; i < uniqueIds.length; i += idChunkSize) {
    const idChunk = uniqueIds.slice(i, i + idChunkSize);

    let from = 0;
    // Page through this id-chunk until a short page signals the end.
    for (;;) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let q: any = supabaseAdmin
        .from(table)
        .select(columns)
        .in(column, idChunk)
        .order(orderColumn, { ascending: true })
        .range(from, from + pageSize - 1);

      if (modify) q = modify(q);

      const { data, error } = await q;
      if (error) throw error;

      const batch = (data ?? []) as T[];
      out.push(...batch);

      if (batch.length < pageSize) break; // last page for this chunk
      from += pageSize;
    }
  }

  return out;
}

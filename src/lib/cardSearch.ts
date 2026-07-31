// src/lib/cardSearch.ts
//
// Card search today only ever matched `name` — typing a card number
// returned nothing, and searching a common name like "Umbreon" returned
// every single printing with no way to narrow it down. This splits a
// free-text query into name tokens and number tokens, so:
//
//   "umbreon"           → name-only, unchanged from today
//   "217"               → number-only (new)
//   "umbreon 217"       → name AND number (new — the actual ask)
//   "shiny umbreon 217" → name matches "shiny" AND "umbreon" (any order),
//                         AND number matches "217"
//
// A token counts as a "number" token if it contains at least one digit —
// TCG card numbers aren't always purely numeric ("TG05", "025a", "SWSH010"),
// so requiring pure digits would miss real cases.

/**
 * Applies name/number matching to a Supabase query builder against the
 * `cards` table. Loosely typed against the query object deliberately —
 * fighting the Supabase JS client's fluent-builder generics for a function
 * this small isn't worth it; every other multi-condition query builder in
 * this codebase does the same (see card.service.ts's own searchCards for
 * the existing convention before this change).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyCardNameNumberSearch(query: any, rawQuery: string): any {
  const tokens = rawQuery.trim().split(/\s+/).filter(Boolean);
  const nameTokens = tokens.filter((t) => !/\d/.test(t));
  const numberTokens = tokens.filter((t) => /\d/.test(t));

  let q = query;
  for (const t of nameTokens) {
    q = q.ilike("name", `%${t}%`);
  }
  for (const t of numberTokens) {
    q = q.ilike("number", `%${t}%`);
  }
  return q;
}

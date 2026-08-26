// src/services/csvImport.service.ts
//
// Orchestrates the CSV-import Phase 2 pipeline (docs/csv-import-design.md):
// parse raw CSV text, then match parsed rows against the live catalog.
// Zero writes — every function here only reads. Shared by the
// /import/parse + /import/match controllers AND
// scripts/validateCsvImportMatch.ts, so the harness is never testing
// different code than what the endpoints run.

import { parseCollectrCsv } from "../lib/csvImportParse";
import { CatalogIndex, matchRow, resolveSet } from "../lib/csvImportMatch";
import {
  fetchCardVariantsByCardIds,
  fetchCardsBySetIds,
  fetchLiveSets,
  fetchProductsBySetIds,
} from "../repositories/csvImportCatalog.repository";
import {
  Confidence,
  MatchResult,
  MatchRowsResult,
  ParsedImportRow,
  ParseCsvResult,
} from "../types/csvImport.types";

export const parseImportCsv = (csvText: string): ParseCsvResult =>
  parseCollectrCsv(csvText);

const emptySummary = (): Record<Confidence, number> => ({
  exact: 0,
  high: 0,
  "needs-review": 0,
  unmatched: 0,
});

export const matchImportRows = async (
  rows: ParsedImportRow[],
): Promise<MatchRowsResult> => {
  const gamesNeeded = Array.from(new Set(rows.map((r) => r.game)));

  // Sets are fetched whole-catalog per game (758 total live rows across
  // both games as of 2026-08-26 — cheap, and resolveSet() needs the full
  // list anyway to detect ambiguity).
  const setsByGameEntries = await Promise.all(
    gamesNeeded.map(async (g) => [g, await fetchLiveSets(g)] as const),
  );
  const setsByGame = Object.fromEntries(setsByGameEntries) as CatalogIndex["setsByGame"];

  // Resolve which sets each row's label points at BEFORE fetching cards/
  // products, so the (much larger) per-set fetches only cover sets actually
  // referenced by this batch, not the whole catalog.
  const neededSetIds = new Set<string>();
  for (const row of rows) {
    const liveSets = setsByGame[row.game] ?? [];
    const res = resolveSet(row.set, row.game, liveSets, row.isJp);
    if (res.matched) neededSetIds.add(res.matched.id);
    // Ambiguous-set candidates also need their cards/products fetched so
    // the harness/review UI can show what each candidate actually
    // contains — cheap relative to the whole catalog, and only happens for
    // the small number of rows that are already below exact confidence.
    for (const c of res.candidates) neededSetIds.add(c.id);
  }

  const setIdList = Array.from(neededSetIds);
  const [cards, products] = await Promise.all([
    fetchCardsBySetIds(setIdList),
    fetchProductsBySetIds(setIdList),
  ]);

  const cardsBySetId = new Map<string, typeof cards>();
  for (const c of cards) {
    if (!cardsBySetId.has(c.setId)) cardsBySetId.set(c.setId, []);
    cardsBySetId.get(c.setId)!.push(c);
  }
  const productsBySetId = new Map<string, typeof products>();
  for (const p of products) {
    if (!productsBySetId.has(p.setId)) productsBySetId.set(p.setId, []);
    productsBySetId.get(p.setId)!.push(p);
  }

  const variants = await fetchCardVariantsByCardIds(cards.map((c) => c.id));
  const variantsByCardId = new Map<string, typeof variants>();
  for (const v of variants) {
    if (!variantsByCardId.has(v.cardId)) variantsByCardId.set(v.cardId, []);
    variantsByCardId.get(v.cardId)!.push(v);
  }

  const index: CatalogIndex = {
    setsByGame,
    cardsBySetId,
    productsBySetId,
    variantsByCardId,
  };

  const results: MatchResult[] = rows.map((row) => matchRow(row, index));
  const summary = emptySummary();
  for (const r of results) summary[r.confidence] += 1;

  return { results, summary };
};

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
  CreateInventoryInput,
  insertInventoryBatch,
} from "../repositories/inventory.repository";
import {
  createImportJob,
  findImportJobByIdempotencyKey,
} from "../repositories/importJobs.repository";
import { getCurrentTotalValue } from "./inventory.service";
import { requireFeature } from "./plan.service";
import { recordReferralInventoryQualificationSafe } from "./referralReward.service";
import {
  CommitImportRequest,
  CommitImportResult,
  Confidence,
  ConfirmedImportItem,
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

// ─── Commit (Phase 3) ───────────────────────────────────────────────────────

// Chunk size for insertInventoryBatch calls — one INSERT per chunk rather
// than one per row (522 rows shouldn't be 522 round trips) or one giant
// INSERT (keeps each statement small and each chunk's failure isolated to
// itself, same reasoning as csvImportCatalog.repository's id-chunking).
const COMMIT_CHUNK_SIZE = 200;

const toCreateInventoryInput = (item: ConfirmedImportItem): CreateInventoryInput => ({
  itemType: item.itemType,
  cardId: item.cardId ?? null,
  productId: item.productId ?? null,
  gradingCompany: (item.gradingCompany as CreateInventoryInput["gradingCompany"]) ?? null,
  grade: item.grade ?? null,
  variantType: item.variantType ?? null,
  isSealed: item.isSealed ?? null,
  quantity: item.quantity,
  purchasePrice: item.purchasePrice ?? null,
  condition: (item.condition as CreateInventoryInput["condition"]) ?? null,
});

const validateConfirmedItem = (item: ConfirmedImportItem): void => {
  if (item.itemType === "raw_card" && !item.cardId) {
    throw { status: 400, message: `row ${item.rowIndex}: card_id is required for raw cards` };
  }
  if (item.itemType === "graded_card") {
    if (!item.cardId) {
      throw { status: 400, message: `row ${item.rowIndex}: card_id is required for graded cards` };
    }
    if (!item.gradingCompany) {
      throw { status: 400, message: `row ${item.rowIndex}: grading_company is required for graded cards` };
    }
    if (!item.grade) {
      throw { status: 400, message: `row ${item.rowIndex}: grade is required for graded cards` };
    }
  }
  if (item.itemType === "sealed_product" && !item.productId) {
    throw { status: 400, message: `row ${item.rowIndex}: product_id is required for sealed products` };
  }
};

/**
 * POST /import/commit. User-confirmed matches only — the client is trusted
 * for WHICH card/product each rowIndex resolves to (see ConfirmedImportItem
 * in csvImport.types.ts for why re-matching here would be wrong, not just
 * redundant). Idempotency-keyed: a repeated call with the same
 * (userId, idempotencyKey) returns the original job's result and writes
 * nothing new.
 */
export const commitImport = async (
  userId: string,
  role: string | null,
  request: CommitImportRequest,
): Promise<CommitImportResult> => {
  const existing = await findImportJobByIdempotencyKey(userId, request.idempotencyKey);
  if (existing) {
    return {
      importJobId: existing.id,
      imported: existing.importedCount,
      notImportedCount: existing.notImported.length,
      portfolioValue: existing.portfolioValueAtImport,
      notImported: existing.notImported,
      replayed: true,
    };
  }

  for (const item of request.items) validateConfirmedItem(item);

  // One feature check per item type present, not per row — same gate
  // addInventoryItem enforces per single-item add (sealed_inventory vs.
  // inventory_tracking), applied once for the whole batch rather than
  // 522 times.
  const itemTypesPresent = new Set(request.items.map((i) => i.itemType));
  if (itemTypesPresent.has("sealed_product")) {
    await requireFeature(userId, "sealed_inventory", role);
  }
  if (itemTypesPresent.has("raw_card") || itemTypesPresent.has("graded_card")) {
    await requireFeature(userId, "inventory_tracking", role);
  }

  const inputs = request.items.map(toCreateInventoryInput);
  for (let i = 0; i < inputs.length; i += COMMIT_CHUNK_SIZE) {
    await insertInventoryBatch(userId, inputs.slice(i, i + COMMIT_CHUNK_SIZE));
  }

  // Referral qualification hook — see inventory.service.ts's addInventoryItem
  // for the pattern. Once per import job, not once per chunk.
  await recordReferralInventoryQualificationSafe(userId);

  const portfolioValue = await getCurrentTotalValue(userId);

  const job = await createImportJob(userId, {
    source: "csv",
    idempotencyKey: request.idempotencyKey,
    totalRows: request.totalRows,
    importedCount: request.items.length,
    notImported: request.notImported,
    portfolioValueAtImport: portfolioValue,
  });

  return {
    importJobId: job.id,
    imported: job.importedCount,
    notImportedCount: job.notImported.length,
    portfolioValue: job.portfolioValueAtImport,
    notImported: job.notImported,
    replayed: false,
  };
};

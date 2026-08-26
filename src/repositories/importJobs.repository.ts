// src/repositories/importJobs.repository.ts
//
// Persistence for POST /import/commit (docs/csv-import-design.md Phase 3,
// migrations/2026-08-26_import_jobs.sql — must be applied before any of
// these queries will succeed against a real database). Two jobs:
//   1. idempotency — findByIdempotencyKey lets the service short-circuit a
//      retried commit instead of writing inventory rows twice.
//   2. the persistent not-imported record (Omar's requirement B) — get/list
//      let the app re-display "we couldn't confirm or import these" after
//      the import session that created it has ended.

import { supabaseAdmin } from "../lib/supabase";
import { NotImportedRow } from "../types/csvImport.types";

const TABLE = "import_jobs";

export interface ImportJobRow {
  id: string;
  userId: string;
  source: string;
  idempotencyKey: string;
  totalRows: number;
  importedCount: number;
  notImported: NotImportedRow[];
  portfolioValueAtImport: number | null;
  status: string;
  createdAt: string;
}

const rowFromDb = (r: any): ImportJobRow => ({
  id: r.id,
  userId: r.user_id,
  source: r.source,
  idempotencyKey: r.idempotency_key,
  totalRows: r.total_rows,
  importedCount: r.imported_count,
  notImported: (r.not_imported ?? []) as NotImportedRow[],
  portfolioValueAtImport: r.portfolio_value_at_import,
  status: r.status,
  createdAt: r.created_at,
});

export const findImportJobByIdempotencyKey = async (
  userId: string,
  idempotencyKey: string,
): Promise<ImportJobRow | null> => {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw error;
  return data ? rowFromDb(data) : null;
};

export const createImportJob = async (
  userId: string,
  input: {
    source?: string;
    idempotencyKey: string;
    totalRows: number;
    importedCount: number;
    notImported: NotImportedRow[];
    portfolioValueAtImport: number | null;
  },
): Promise<ImportJobRow> => {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert({
      user_id: userId,
      source: input.source ?? "csv",
      idempotency_key: input.idempotencyKey,
      total_rows: input.totalRows,
      imported_count: input.importedCount,
      not_imported: input.notImported,
      portfolio_value_at_import: input.portfolioValueAtImport,
      status: "completed",
    })
    .select("*")
    .single();
  if (error) throw error;
  return rowFromDb(data);
};

export const getImportJob = async (
  userId: string,
  jobId: string,
): Promise<ImportJobRow | null> => {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .eq("id", jobId)
    .maybeSingle();
  if (error) throw error;
  return data ? rowFromDb(data) : null;
};

export const listImportJobs = async (
  userId: string,
  limit = 20,
): Promise<ImportJobRow[]> => {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map(rowFromDb);
};

// src/controllers/csvImport.controller.ts
//
// POST /import/parse and POST /import/match — stateless, zero writes
// (docs/csv-import-design.md §1e Phase 2). No multer/multipart in this repo
// (app.ts only wires express.json/urlencoded) — CSV text travels in the
// JSON body, same as scan.controller.ts's base64-image pattern, rather than
// adding a new upload dependency for a ~50KB text file.

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  commitImport,
  matchImportRows,
  parseImportCsv,
} from "../services/csvImport.service";
import {
  getImportJob,
  listImportJobs,
} from "../repositories/importJobs.repository";
import { handlePlanError } from "../middleware/plan.middleware";

const handleError = (res: Response, err: unknown) => {
  if (handlePlanError(res, err)) return;
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    res.status(e.status).json({ error: e.message ?? "Error" });
    return;
  }
  console.error("[CsvImportController]", err);
  res.status(500).json({ error: "An unexpected error occurred" });
};

// POST /import/parse
// Body: { csv: string }
export const parse = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const csv = req.body?.csv;
    if (typeof csv !== "string" || csv.trim() === "") {
      res.status(400).json({ error: "csv (string) is required" });
      return;
    }
    const result = parseImportCsv(csv);
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /import/match
// Body: { rows: ParsedImportRow[] } — the `rows` array from /import/parse's
// response, passed through unmodified. Kept as a separate step from parse
// so a client can show a raw-parse preview (row counts, parse errors)
// before paying for the catalog-matching pass.
export const match = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rows = req.body?.rows;
    if (!Array.isArray(rows)) {
      res.status(400).json({ error: "rows (array) is required" });
      return;
    }
    if (rows.length > 2000) {
      res.status(400).json({ error: "Too many rows in one request (max 2000)" });
      return;
    }
    const result = await matchImportRows(rows);
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /import/commit
// Body: CommitImportRequest — { idempotencyKey, totalRows, items, notImported }
export const commit = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { idempotencyKey, totalRows, items, notImported } = req.body ?? {};
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim() === "") {
      res.status(400).json({ error: "idempotencyKey (string) is required" });
      return;
    }
    if (!Array.isArray(items) || !Array.isArray(notImported) || typeof totalRows !== "number") {
      res.status(400).json({ error: "totalRows (number), items (array), notImported (array) are required" });
      return;
    }
    const result = await commitImport(req.user.id, req.user.role ?? null, {
      idempotencyKey,
      totalRows,
      items,
      notImported,
    });
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /import/jobs/:id — retrieve one job's persistent not-imported record
// after the import session that created it has ended (requirement B).
export const getJob = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const job = await getImportJob(req.user.id, req.params.id);
    if (!job) {
      res.status(404).json({ error: "Import job not found" });
      return;
    }
    res.json({ data: job });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /import/jobs — recent import jobs for the current user
export const listJobs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const jobs = await listImportJobs(req.user.id);
    res.json({ data: jobs });
  } catch (err) {
    handleError(res, err);
  }
};

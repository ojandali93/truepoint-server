// src/controllers/csvImport.controller.ts
//
// POST /import/parse and POST /import/match — stateless, zero writes
// (docs/csv-import-design.md §1e Phase 2). No multer/multipart in this repo
// (app.ts only wires express.json/urlencoded) — CSV text travels in the
// JSON body, same as scan.controller.ts's base64-image pattern, rather than
// adding a new upload dependency for a ~50KB text file.

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { matchImportRows, parseImportCsv } from "../services/csvImport.service";

const handleError = (res: Response, err: unknown) => {
  console.error("[CsvImportController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
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

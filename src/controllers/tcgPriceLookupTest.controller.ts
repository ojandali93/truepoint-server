// src/controllers/tcgPriceLookupTest.controller.ts
//
// Admin-only diagnostic for evaluating TCG Price Lookup as a possible
// replacement for PokeTrace's graded pricing. Two endpoints: search (to
// find a card's TCG Price Lookup UUID, since this vendor uses its own
// IDs, not TCGPlayer's) and detail (fetches the full card, scans it for
// anything grading-shaped, returns both the scan results and the raw
// response so a human can verify nothing was missed).
//
// Read-only. Nothing here writes to market_prices or touches the
// production graded-price pipeline in any way.

import { Response } from "express";

import { AuthenticatedRequest } from "../types/user.types";
import { logError } from "../lib/Logger";
import { searchCards, getCardDetail } from "../lib/tcgPriceLookupClient";

// POST /admin/tcg-price-lookup-test/search
// Body: { query: string, game?: string }
export const testSearch = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { query, game } = req.body ?? {};
    if (!query || typeof query !== "string") {
      res.status(400).json({ error: "query is required" });
      return;
    }
    const result = await searchCards(query, game);
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "tcgpricelookup-test-search",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { body: req.body },
    });
    res.status(500).json({ error: err?.message ?? "Search failed" });
  }
};

// POST /admin/tcg-price-lookup-test/detail
// Body: { id: string }  — the TCG Price Lookup UUID from a search result
export const testDetail = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.body ?? {};
    if (!id || typeof id !== "string") {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const { raw, gradingHits } = await getCardDetail(id);
    res.json({ data: { raw, gradingHits } });
  } catch (err: any) {
    await logError({
      source: "tcgpricelookup-test-detail",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { body: req.body },
    });
    res.status(500).json({ error: err?.message ?? "Detail fetch failed" });
  }
};

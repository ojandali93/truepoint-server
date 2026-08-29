// src/controllers/watchlist.controller.ts

import { Response } from "express";

import { AuthenticatedRequest } from "../types/user.types";
import { logError } from "../lib/Logger";
import * as WatchlistService from "../services/watchlist.service";
import { handlePlanError } from "../middleware/plan.middleware";

const handle = (res: Response, err: unknown, source: string) => {
  // Phase 1 gate 4: checked first so addToWatchlist's PLAN_LIMIT_REACHED
  // throw (canAddMoreToWatchlist, watchlist.service.ts) surfaces with
  // limit/current/upgradeTo, not just {error, status} — same structured
  // shape gradingLifecycle's and getGradingArbitrage's limit errors now
  // carry.
  if (handlePlanError(res, err)) return;
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    res.status(e.status).json({ error: e.message ?? "Error" });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  void logError({ source, message, error: err, userId: null });
  res.status(500).json({ error: message });
};

// GET /api/v1/watchlist
export const listWatchlist = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const items = await WatchlistService.listWatchlist(req.user.id);
    res.json({ data: items });
  } catch (err) {
    handle(res, err, "watchlist-list");
  }
};

// POST /api/v1/watchlist
export const addToWatchlist = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const created = await WatchlistService.addToWatchlist(
      req.user.id,
      {
        cardId: body.cardId ?? null,
        productId: body.productId ?? null,
        targetCompany: body.targetCompany ?? null,
        targetGrade: body.targetGrade ?? null,
        buyBelowPrice:
          body.buyBelowPrice !== undefined && body.buyBelowPrice !== null
            ? Number(body.buyBelowPrice)
            : null,
        sellAbovePrice:
          body.sellAbovePrice !== undefined && body.sellAbovePrice !== null
            ? Number(body.sellAbovePrice)
            : null,
        notes: body.notes ?? null,
      },
      req.user.role,
    );
    res.status(201).json({ data: created });
  } catch (err) {
    handle(res, err, "watchlist-add");
  }
};

// PATCH /api/v1/watchlist/:id
export const updateWatchlistItem = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    for (const key of ["buyBelowPrice", "sellAbovePrice", "notes"]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    await WatchlistService.updateWatchlistItem(
      req.user.id,
      req.params.id,
      patch,
    );
    res.json({ data: { updated: true } });
  } catch (err) {
    handle(res, err, "watchlist-update");
  }
};

// DELETE /api/v1/watchlist/:id
export const removeFromWatchlist = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    await WatchlistService.removeFromWatchlist(req.user.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    handle(res, err, "watchlist-remove");
  }
};

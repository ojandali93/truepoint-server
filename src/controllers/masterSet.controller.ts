// src/controllers/masterSet.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  getTrackedSets,
  getSetCards,
  trackSet,
  untrackSet,
  canTrackMoreSets,
  toggleCard,
  updateCardQuantity,
} from "../services/masterSet.service";
import { logError } from "../lib/Logger";
import { handlePlanError } from "../middleware/plan.middleware";

// GET /master-sets — all tracked sets with progress
export const getTracked = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [sets, limit] = await Promise.all([
      getTrackedSets(req.user.id),
      canTrackMoreSets(req.user.id, req.user.role ?? null),
    ]);
    res.json({ data: { sets, limit } });
  } catch (e: any) {
    await logError({
      source: "get-tracked-sets", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// GET /master-sets/limit — plan limit info
export const getLimit = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = await canTrackMoreSets(req.user.id, req.user.role ?? null);
    res.json({ data: limit });
  } catch (e: any) {
    await logError({
      source: "get-limit", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// GET /master-sets/:setId — full card list with collection status
export const getSetDetail = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const result = await getSetCards(req.user.id, req.params.setId);
    if (!result.progress) {
      res.status(404).json({ error: "Set not found" });
      return;
    }
    res.json({ data: result });
  } catch (e: any) {
    await logError({
      source: "get-set-detail", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// POST /master-sets/:setId/track — start tracking a set
export const startTracking = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    // req.user.role wasn't passed before — trackSet defaulted to null,
    // meaning an admin hitting this endpoint didn't get resolvePlan's
    // admin → effectivePlan 'pro' override and was incorrectly subject to
    // the master-set limit. Found and fixed alongside the error-handling
    // gap below (Phase 1 gate 5) since it's the same call.
    const result = await trackSet(
      req.user.id,
      req.params.setId,
      req.user.role,
    );
    if (!result.success) {
      res.status(403).json({ error: result.error, upgradeRequired: true });
      return;
    }
    res.json({ data: { tracked: true } });
  } catch (e: any) {
    // Phase 1 gate 5: trackSet's limit error (now code PLAN_LIMIT_REACHED,
    // see masterSet.service.ts) was falling through to the bare 500 below
    // — this endpoint had no handlePlanError call at all, unlike every
    // other plan-gated write as of gate 4 (gradingLifecycle.controller.ts,
    // watchlist.controller.ts, grading.controller.ts). The counters UI
    // (gate 5) surfaces this error to real users now, so it needed to
    // actually carry status/code/limit/current instead of a bare 500.
    if (handlePlanError(res, e)) return;
    await logError({
      source: "start-tracking", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// DELETE /master-sets/:setId/track — stop tracking a set
export const stopTracking = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await untrackSet(req.user.id, req.params.setId);
    res.json({ data: { tracked: false } });
  } catch (e: any) {
    await logError({
      source: "stop-tracking", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// POST /master-sets/:setId/cards/:cardId/toggle — mark/unmark a card variant
// Body: { variantType: string }
export const toggleCardCollected = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { setId, cardId } = req.params;
    const { variantType = "normal" } = req.body;
    const result = await toggleCard(req.user.id, setId, cardId, variantType);
    res.json({ data: result });
  } catch (e: any) {
    await logError({
      source: "toggle-card-collected", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

// PUT /master-sets/:setId/cards/:cardId/quantity — set exact quantity (for dupes)
// Body: { variantType: string, quantity: number }
export const setCardQuantity = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { setId, cardId } = req.params;
    const { variantType = "normal", quantity } = req.body;
    await updateCardQuantity(req.user.id, setId, cardId, variantType, quantity);
    res.json({ data: { quantity } });
  } catch (e: any) {
    await logError({
      source: "set-card-quantity", // ← change per controller
      message: e?.message ?? "Unknown error",
      error: e,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: e?.message });
  }
};

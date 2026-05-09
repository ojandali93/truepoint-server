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

const handleError = (res: Response, e: unknown) => {
  console.error("[MasterSet]", e);
  res.status(500).json({ error: "Internal server error" });
};

// GET /master-sets — all tracked sets with progress
export const getTracked = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [sets, limit] = await Promise.all([
      getTrackedSets(req.user.id),
      canTrackMoreSets(req.user.id),
    ]);
    res.json({ data: { sets, limit } });
  } catch (e) {
    handleError(res, e);
  }
};

// GET /master-sets/limit — plan limit info
export const getLimit = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const limit = await canTrackMoreSets(req.user.id);
    res.json({ data: limit });
  } catch (e) {
    handleError(res, e);
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
  } catch (e) {
    handleError(res, e);
  }
};

// POST /master-sets/:setId/track — start tracking a set
export const startTracking = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const result = await trackSet(req.user.id, req.params.setId);
    if (!result.success) {
      res.status(403).json({ error: result.error, upgradeRequired: true });
      return;
    }
    res.json({ data: { tracked: true } });
  } catch (e) {
    handleError(res, e);
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
  } catch (e) {
    handleError(res, e);
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
  } catch (e) {
    handleError(res, e);
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
  } catch (e) {
    handleError(res, e);
  }
};

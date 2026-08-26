// src/controllers/regradeTracker.controller.ts

import { Response } from "express";

import { AuthenticatedRequest } from "../types/user.types";
import { logError } from "../lib/Logger";
import {
  getGradeLadder,
  createTrackedRegrade,
  listTrackedRegrades,
  updateTrackedRegrade,
  deleteTrackedRegrade,
  TrackedRegradeInput,
} from "../services/regradeTracker.service";
import { isFlagEnabled } from "../services/featureFlag.service";
import { FLAG_KEYS } from "../constants/featureFlagKeys";

// Status-aware error handler — mirrors inventory.controller.ts's
// handleError exactly, so a service throwing { status, message } (ownership
// checks, validation) surfaces the right HTTP code instead of always 500.
const handle = (res: Response, err: unknown, source: string) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    res.status(e.status).json({ error: e.message ?? "Error" });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  void logError({
    source,
    message,
    error: err,
    userId: null,
  });
  res.status(500).json({ error: message });
};

// GET /api/v1/regrades/:cardId/ladder
export const getLadder = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    // Same flag as getCardGradedPrices/getGradingArbitrage — a user tracks
    // a regrade candidate based on this ladder, so it gets the locked
    // precedence contract the instant the flag opens for that user.
    const useNewGradedPrecedence = await isFlagEnabled(
      FLAG_KEYS.PRICECHARTING_PRICING,
      req.user.id,
    );
    const result = await getGradeLadder(req.params.cardId, useNewGradedPrecedence);
    res.json({ data: result });
  } catch (err) {
    handle(res, err, "regrade-ladder");
  }
};

// GET /api/v1/regrades
export const listTracked = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const result = await listTrackedRegrades(req.user.id);
    res.json({ data: result });
  } catch (err) {
    handle(res, err, "regrade-list");
  }
};

// POST /api/v1/regrades
export const createTracked = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const input: TrackedRegradeInput = {
      cardId: body.cardId,
      currentCompany: body.currentCompany ?? null,
      currentGrade: body.currentGrade ?? null,
      subCentering: body.subCentering ?? null,
      subCorners: body.subCorners ?? null,
      subEdges: body.subEdges ?? null,
      subSurface: body.subSurface ?? null,
      targetCompany: body.targetCompany,
      targetGrade: body.targetGrade,
      acquisitionPrice: body.acquisitionPrice ?? null,
      status: body.status,
      notes: body.notes ?? null,
    };
    const created = await createTrackedRegrade(req.user.id, input);
    res.status(201).json({ data: created });
  } catch (err) {
    handle(res, err, "regrade-create");
  }
};

// PATCH /api/v1/regrades/:id
export const updateTracked = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const patch: Partial<TrackedRegradeInput> = {};
    // Only forward fields actually present — undefined means "don't touch",
    // matches updateTrackedRegrade's own convention.
    for (const key of [
      "currentCompany",
      "currentGrade",
      "subCentering",
      "subCorners",
      "subEdges",
      "subSurface",
      "targetCompany",
      "targetGrade",
      "acquisitionPrice",
      "status",
      "notes",
    ] as const) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    const updated = await updateTrackedRegrade(
      req.user.id,
      req.params.id,
      patch,
    );
    res.json({ data: updated });
  } catch (err) {
    handle(res, err, "regrade-update");
  }
};

// DELETE /api/v1/regrades/:id
export const deleteTracked = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    await deleteTrackedRegrade(req.user.id, req.params.id);
    res.status(204).send();
  } catch (err) {
    handle(res, err, "regrade-delete");
  }
};

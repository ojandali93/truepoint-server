// src/controllers/grading.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  getGradingArbitrage,
  GRADING_COSTS,
} from "../services/gradingArbitrage.service";
import { logError } from "../lib/Logger";
import { isFlagEnabled } from "../services/featureFlag.service";
import { FLAG_KEYS } from "../constants/featureFlagKeys";

// GET /api/v1/grading/arbitrage
export const getArbitrage = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const service = (req.query.service as string) ?? "PSA";
    const tier = (req.query.tier as string) ?? "value";
    const grade = (req.query.grade as string) ?? "10";
    // Same flag as getCardGradedPrices/fetchCardPrices — this is a paid
    // decision surface (a user pays to grade based on this ROI), so it
    // gets the locked precedence contract the instant the flag opens for
    // that user, not a lesser standard.
    const useNewGradedPrecedence = await isFlagEnabled(
      FLAG_KEYS.PRICECHARTING_PRICING,
      req.user.id,
    );
    const result = await getGradingArbitrage(
      req.user.id,
      service,
      tier,
      grade,
      useNewGradedPrecedence,
    );
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "get-arbitrage", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// GET /api/v1/grading/costs
export const getGradingCosts = async (
  _req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  res.json({ data: GRADING_COSTS });
};

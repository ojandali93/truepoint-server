// src/controllers/plan.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { getPlanSnapshot } from "../services/plan.service";

// GET /me/plan — returns plan + monthly usage + feature flags for the UI
export const getMyPlan = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const snapshot = await getPlanSnapshot(req.user.id, req.user.role);
    res.json({ data: snapshot });
  } catch (err) {
    console.error("[PlanController]", err);
    res.status(500).json({ error: "Failed to load plan" });
  }
};

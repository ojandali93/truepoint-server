// src/middleware/plan.middleware.ts
//
// Convenience middleware to gate routes by feature. For limit-based checks
// (monthly caps, etc.), call the plan.service functions directly from the
// controller so we can include current usage in the error.

import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  requireFeature,
  FeatureKey,
  PlanError,
} from "../services/plan.service";

export const requirePlanFeature =
  (feature: FeatureKey) =>
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    try {
      await requireFeature(req.user.id, feature, req.user.role);
      next();
    } catch (err) {
      const e = err as PlanError;
      res.status(e.status ?? 403).json({
        error: e.message,
        code: e.code,
        upgradeTo: e.upgradeTo,
      });
    }
  };

/**
 * Helper for controllers that need to inline a plan error response.
 * Returns true if it handled the error, false otherwise.
 */
export const handlePlanError = (res: Response, err: unknown): boolean => {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as PlanError).code === "string" &&
    ((err as PlanError).code === "PLAN_FEATURE_LOCKED" ||
      (err as PlanError).code === "PLAN_LIMIT_REACHED")
  ) {
    const e = err as PlanError;
    res.status(e.status ?? 403).json({
      error: e.message,
      code: e.code,
      upgradeTo: e.upgradeTo,
      limit: e.limit,
      current: e.current,
    });
    return true;
  }
  return false;
};

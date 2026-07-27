// src/middleware/flag.middleware.ts
//
// Route-level gating for unreleased features, mirroring requirePlanFeature
// in plan.middleware.ts. Use this on any route that belongs to a feature
// still behind a flag:
//
//   router.get(
//     "/regrades/:cardId/ladder",
//     requireFlagMiddleware("regrade_tracker"),
//     Controller.getLadder,
//   );
//
// This is deliberately separate from requirePlanFeature: that answers "does
// your plan include this" (entitlement), this answers "has it shipped to
// you yet" (rollout). A feature can — and for anything currently in
// development, should — be checked by both.

import { NextFunction, Response } from "express";

import { AuthenticatedRequest } from "../types/user.types";
import { isFlagEnabled } from "../services/featureFlag.service";

export const requireFlagMiddleware =
  (key: string) =>
  async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> => {
    const ok = await isFlagEnabled(key, req.user.id, req.user.role);
    if (!ok) {
      // 404, not 403 — to a user outside the rollout, a dark feature should
      // be indistinguishable from a route that was never built. A 403 would
      // confirm the endpoint exists.
      res.status(404).json({ error: "Not found" });
      return;
    }
    next();
  };

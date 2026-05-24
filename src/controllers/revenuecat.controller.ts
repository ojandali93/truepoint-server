import { Request, Response } from "express";
import {
  verifyRevenueCatAuth,
  handleRevenueCatEvent,
} from "../services/revenuecat.service";
import { logError } from "../lib/Logger";

export const handleRevenueCatWebhook = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const authHeader = req.headers["authorization"] as string | undefined;
    if (!verifyRevenueCatAuth(authHeader)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    await handleRevenueCatEvent(req.body);

    // Always 200 quickly so RevenueCat doesn't retry on slow processing.
    res.json({ received: true });
  } catch (err: any) {
    await logError({
      source: "revenuecat-webhook",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: {},
    });
    // Still 200 — log the error but don't trigger infinite RevenueCat retries
    // for a malformed event. Investigate via logs.
    res.status(200).json({ received: true, logged: true });
  }
};

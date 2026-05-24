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

    // ── TEMPORARY DIAGNOSTIC (remove after webhook auth confirmed) ──
    // Logs lengths and short masked previews only — never the full secret.
    const expectedDbg = process.env.REVENUECAT_WEBHOOK_AUTH;
    const mask = (s?: string) =>
      s ? `${s.slice(0, 6)}…${s.slice(-4)} (len=${s.length})` : "<<MISSING>>";
    console.log("[rc-webhook][DBG] received auth:", mask(authHeader));
    console.log("[rc-webhook][DBG] expected env :", mask(expectedDbg));
    console.log(
      "[rc-webhook][DBG] match:",
      authHeader === expectedDbg,
      "| env set:",
      typeof expectedDbg === "string",
    );
    // ── END TEMPORARY DIAGNOSTIC ──

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

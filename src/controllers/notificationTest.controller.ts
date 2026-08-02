// src/controllers/notificationTest.controller.ts
//
// Admin-only. Lets an admin trigger any of the personalized notification
// types against ONE specific account — defaulting to their own — so
// content can be verified against real data before any wider run. This is
// the direct answer to "make sure notifications go to the right person":
// every call here is scoped to exactly one userId, explicitly, and that
// scoping happens inside the underlying service functions themselves (see
// watchlistTriggers.service.ts's onlyUserId, and the existing single-user
// exports in portfolioSummary/priceMoversDigest), not as a filter bolted
// on after the fact.

import { Response } from "express";

import { AuthenticatedRequest } from "../types/user.types";
import { logError } from "../lib/Logger";
import { sendDailySummaryToUser } from "../services/portfolioSummary.service";
import { sendPriceMoversToUser } from "../services/priceMoversDigest.service";
import { checkWatchlistTriggers } from "../services/watchlistTriggers.service";

const VALID_TYPES = [
  "daily-summary",
  "price-movers",
  "watchlist-triggers",
] as const;
type NotificationTestType = (typeof VALID_TYPES)[number];

// POST /admin/notifications/test-send
// Body: { type: "daily-summary" | "price-movers" | "watchlist-triggers",
//          userId?: string (defaults to the calling admin's own id),
//          dryRun?: boolean (watchlist-triggers only) }
export const testSendNotification = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const body = req.body ?? {};
    const type = body.type as NotificationTestType;
    if (!VALID_TYPES.includes(type)) {
      res
        .status(400)
        .json({ error: `type must be one of ${VALID_TYPES.join(", ")}` });
      return;
    }

    // Default to the calling admin's own account — the whole point of this
    // tool is "verify on myself before anyone else sees it."
    const targetUserId: string = body.userId || req.user.id;

    if (type === "daily-summary") {
      const sent = await sendDailySummaryToUser(targetUserId);
      res.json({ data: { type, targetUserId, sent } });
      return;
    }

    if (type === "price-movers") {
      const sent = await sendPriceMoversToUser(targetUserId);
      res.json({ data: { type, targetUserId, sent } });
      return;
    }

    // watchlist-triggers
    const dryRun = body.dryRun !== false; // dry-run BY DEFAULT — an explicit
    // `dryRun: false` is required to actually send here, since a real send
    // also mutates last_notified_*, unlike the other two types.
    const summary = await checkWatchlistTriggers({
      onlyUserId: targetUserId,
      dryRun,
    });
    res.json({ data: { type, targetUserId, dryRun, ...summary } });
  } catch (err: any) {
    await logError({
      source: "notification-test-send",
      message: err?.message ?? "Test send failed",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { body: req.body },
    });
    res.status(500).json({ error: err?.message ?? "Test send failed" });
  }
};

// src/routes/watchlist.routes.ts
//
// Every route here is gated behind the "watchlist" flag — allowlist the
// tester account in admin before any of these respond with real data.

import { Router } from "express";

import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import { requireFlagMiddleware } from "../middleware/flag.middleware";
import { FLAG_KEYS } from "../constants/featureFlagKeys";
import * as WatchlistController from "../controllers/watchlist.controller";

const router = Router();
router.use(authenticateUser as any);
router.use(requireFlagMiddleware(FLAG_KEYS.WATCHLIST) as any);

router.get("/", standardLimiter, WatchlistController.listWatchlist as any);
router.post("/", standardLimiter, WatchlistController.addToWatchlist as any);
router.patch(
  "/:id",
  standardLimiter,
  WatchlistController.updateWatchlistItem as any,
);
router.delete(
  "/:id",
  standardLimiter,
  WatchlistController.removeFromWatchlist as any,
);

export default router;

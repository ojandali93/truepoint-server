// src/routes/trades.routes.ts
//
// Mounted in app.ts:  app.use("/api/v1/trades", tradesRoutes);

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as TradesController from "../controllers/trades.controller";

const router = Router();

router.use(authenticateUser as any);

// GET    /api/v1/trades        — trade history
router.get("/", standardLimiter, TradesController.listTrades as any);

// POST   /api/v1/trades        — record a trade (moves give-side out of
//                                inventory, adds get-side, writes the journal)
router.post("/", writeLimiter, TradesController.recordTrade as any);

// DELETE /api/v1/trades/:id    — revert a trade and remove the journal row
router.delete("/:id", writeLimiter, TradesController.deleteTrade as any);

export default router;

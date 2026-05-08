import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as PortfolioController from "../controllers/portfolio.controller";

const router = Router();

router.use(authenticateUser as any);

// GET  /api/v1/portfolio?days=90
// Full portfolio analytics — history, breakdown, top performers
router.get("/", standardLimiter, PortfolioController.getPortfolio as any);

// POST /api/v1/portfolio/snapshot
// Trigger a snapshot for the current user (also used by cron)
router.post(
  "/snapshot",
  writeLimiter,
  PortfolioController.createSnapshot as any,
);

export default router;

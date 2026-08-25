import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as PortfolioService from "../services/portfolio.service";
import {
  getPortfolioMovers,
  MoversWindow,
} from "../services/portfolioMovers.service";
import { handlePlanError } from "../middleware/plan.middleware";

const VALID_WINDOWS: MoversWindow[] = ["1d", "7d", "30d"];

const handleError = (res: Response, err: unknown) => {
  if (handlePlanError(res, err)) return;
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[PortfolioController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// GET /portfolio
// Full portfolio data — history, breakdown, gainers, losers
export const getPortfolio = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const days = parseInt(req.query.days as string) || 90;
    const collectionId = req.query.collectionId as string | undefined;
    const data = await PortfolioService.getPortfolio(
      req.user.id,
      days,
      collectionId ?? null,
      req.user.role,
    );
    res.json({ data });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /portfolio/movers?window=1d|7d|30d&collectionId=<optional>
// Portfolio change attribution — market movement vs. inventory adds/removals
export const getMovers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const windowParam = (req.query.window as string) || "7d";
    if (!VALID_WINDOWS.includes(windowParam as MoversWindow)) {
      res.status(400).json({ error: "window must be one of: 1d, 7d, 30d" });
      return;
    }
    const collectionId = req.query.collectionId as string | undefined;
    const data = await getPortfolioMovers(
      req.user.id,
      windowParam as MoversWindow,
      collectionId ?? null,
      req.user.role,
    );
    res.json({ data });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /portfolio/snapshot
// Manually trigger a snapshot for the current user
// Also called by the cron job via sync routes
export const createSnapshot = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await PortfolioService.createSnapshotForUser(req.user.id);
    res.json({ message: "Snapshot created successfully" });
  } catch (err) {
    handleError(res, err);
  }
};

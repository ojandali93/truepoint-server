import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as PortfolioService from "../services/portfolio.service";

const handleError = (res: Response, err: unknown) => {
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

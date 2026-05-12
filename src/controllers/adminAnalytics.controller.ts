// src/controllers/adminAnalytics.controller.ts
// Wraps analytics service functions as proper Express request handlers.

import { Request, Response } from "express";
import {
  getUserStats,
  getCollectionStats,
  getSetAnalytics,
} from "../services/adminAnalytics.service";

const handle = (res: Response, err: unknown) => {
  const msg = err instanceof Error ? err.message : "Analytics query failed";
  console.error("[AdminAnalytics]", err);
  res.status(500).json({ error: msg });
};

export const getUserAnalytics = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const data = await getUserStats();
    res.json({ data });
  } catch (err) {
    handle(res, err);
  }
};

export const getCollectionAnalytics = async (
  _req: Request,
  res: Response,
): Promise<void> => {
  try {
    const data = await getCollectionStats();
    res.json({ data });
  } catch (err) {
    handle(res, err);
  }
};

export const getSetAnalyticsHandler = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 50);
    const data = await getSetAnalytics(limit);
    res.json({ data });
  } catch (err) {
    handle(res, err);
  }
};

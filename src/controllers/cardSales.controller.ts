import { Request, Response } from "express";
import { getRecentSales } from "../services/cardSales.service";

// GET /api/v1/cards/:cardId/recent-sales
export const getCardRecentSales = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { cardId } = req.params;
    if (!cardId) {
      res.status(400).json({ error: "cardId required" });
      return;
    }
    const data = await getRecentSales(cardId, 15);
    res.json({ data });
  } catch (err: any) {
    res
      .status(500)
      .json({ error: err?.message ?? "Failed to load recent sales" });
  }
};

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as TradesService from "../services/trades.service";

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[TradesController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// GET /trades — trade history, newest first
export const listTrades = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const items = await TradesService.listTrades(req.user.id);
    res.json({ data: { items } });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /trades — record a trade (mutates inventory)
export const recordTrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { giveCards, getCards, giveCash, getCash, notes } = req.body;
    const trade = await TradesService.recordTrade(req.user.id, {
      giveCards: giveCards ?? [],
      getCards: getCards ?? [],
      giveCash,
      getCash,
      notes: notes ?? null,
    });
    res.json({ data: trade });
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /trades/:id — revert + remove a trade
export const deleteTrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await TradesService.deleteTrade(req.params.id, req.user.id);
    res.json({ data: { id: req.params.id } });
  } catch (err) {
    handleError(res, err);
  }
};

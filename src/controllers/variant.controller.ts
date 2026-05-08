// src/controllers/variant.controller.ts
import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as VariantService from "../services/variant.service";

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[VariantController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// GET /variants/sets/:setId/status
export const getSetStatus = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const status = await VariantService.getSetVariantStatus(req.params.setId);
    res.json({ data: { status } });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /variants/sets/:setId
// Full variant data — rules + per-card variants
export const getSetVariants = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const data = await VariantService.getSetVariantData(req.params.setId);
    res.json({ data });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /variants/sets/:setId/cards
// Cards with their variants embedded — used by open product modal
export const getCardsWithVariants = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const cards = await VariantService.getCardsWithVariants(req.params.setId);
    res.json({ data: cards });
  } catch (err) {
    handleError(res, err);
  }
};

// GET /variants/sets/:setId/rules
// Set-level variant rules (admin)
export const getSetRules = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rules = await VariantService.getSetVariantRules(req.params.setId);
    res.json({ data: rules });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /variants/sets/:setId/save
// Admin: save full variant config — rules + card overrides — marks set as ready
export const saveSetVariants = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { rules, cardOverrides } = req.body;
    const result = await VariantService.saveSetVariants({
      setId: req.params.setId,
      rules: rules ?? [],
      cardOverrides: cardOverrides ?? [],
    });
    res.json({
      data: result,
      message: `Saved ${result.saved} variant records`,
    });
  } catch (err) {
    handleError(res, err);
  }
};

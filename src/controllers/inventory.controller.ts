import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as InventoryService from "../services/inventory.service";

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[InventoryController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// GET /inventory
// Returns all inventory items with live market prices + summary totals
export const getInventory = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const result = await InventoryService.getInventory(req.user.id);
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /inventory
// Add a raw card, graded card, or sealed product
export const addInventoryItem = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const {
      itemType,
      cardId,
      productId,
      gradingCompany,
      grade,
      serialNumber,
      isSealed,
      purchasePrice,
      purchaseDate,
      notes,
    } = req.body;

    const item = await InventoryService.addInventoryItem(req.user.id, {
      itemType,
      cardId: cardId ?? null,
      productId: productId ?? null,
      gradingCompany: gradingCompany ?? null,
      grade: grade ?? null,
      serialNumber: serialNumber ?? null,
      isSealed: isSealed ?? null,
      purchasePrice: purchasePrice ? Number(purchasePrice) : null,
      purchaseDate: purchaseDate ?? null,
      notes: notes ?? null,
    });

    res.status(201).json({ data: item });
  } catch (err) {
    handleError(res, err);
  }
};

// PUT /inventory/:id
// Edit purchase price, notes, grade, serial number, etc.
export const editInventoryItem = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const {
      gradingCompany,
      grade,
      serialNumber,
      isSealed,
      purchasePrice,
      purchaseDate,
      notes,
    } = req.body;

    const item = await InventoryService.editInventoryItem(
      req.params.id,
      req.user.id,
      {
        gradingCompany: gradingCompany ?? undefined,
        grade: grade ?? undefined,
        serialNumber: serialNumber ?? undefined,
        isSealed: isSealed ?? undefined,
        purchasePrice:
          purchasePrice !== undefined ? Number(purchasePrice) : undefined,
        purchaseDate: purchaseDate ?? undefined,
        notes: notes ?? undefined,
      },
    );

    res.json({ data: item });
  } catch (err) {
    handleError(res, err);
  }
};

// DELETE /inventory/:id
export const removeInventoryItem = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await InventoryService.removeInventoryItem(req.params.id, req.user.id);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
};

// POST /inventory/:id/open
// Open a sealed product — insert pulled cards, delete the product
export const openSealedProduct = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { pulledCards } = req.body;

    if (!Array.isArray(pulledCards) || !pulledCards.length) {
      return res.status(400).json({
        error:
          "pulledCards must be a non-empty array of { cardId, purchasePrice?, notes? }",
      });
    }

    const result = await InventoryService.openSealedProduct(
      req.params.id,
      req.user.id,
      pulledCards,
    );

    res.json({
      data: result,
      message: `Product opened — ${result.inserted} cards added to inventory`,
    });
  } catch (err) {
    handleError(res, err);
  }
};

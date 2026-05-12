// src/controllers/collection.controller.ts

import { Request, Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  getCollections,
  getCollectionSummaries,
  createCollection,
  updateCollection,
  deleteCollection,
  setDefaultCollection,
  ensureDefaultCollection,
} from "../services/collection.service";

const uid = (req: Request) => (req as AuthenticatedRequest).user!.id;
const fail = (res: Response, err: unknown) => {
  const e = err as any;
  const msg = e?.message ?? "Collection operation failed";
  console.error("[Collection]", err);
  res.status(e?.status ?? 500).json({ error: msg });
};

// GET /collections — list with summary (item count + value)
export const listCollections = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const summaries = await getCollectionSummaries(uid(req));
    res.json({ data: summaries });
  } catch (err) {
    fail(res, err);
  }
};

// GET /collections/raw — lightweight list (no counts), for dropdowns
export const listCollectionsRaw = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const collections = await getCollections(uid(req));
    res.json({ data: collections });
  } catch (err) {
    fail(res, err);
  }
};

// POST /collections
export const createColl = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { name, description, color, icon } = req.body;
    if (!name?.trim()) {
      res.status(400).json({ error: "Collection name is required" });
      return;
    }
    const collection = await createCollection(uid(req), {
      name,
      description,
      color,
      icon,
    });
    res.status(201).json({ data: collection });
  } catch (err) {
    fail(res, err);
  }
};

// PATCH /collections/:id
export const updateColl = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const { name, description, color, icon } = req.body;
    const collection = await updateCollection(req.params.id, uid(req), {
      name,
      description,
      color,
      icon,
    });
    res.json({ data: collection });
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /collections/:id?strategy=reassign|delete
export const deleteColl = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const strategy = req.query.strategy === "delete" ? "delete" : "reassign";
    await deleteCollection(req.params.id, uid(req), strategy);
    res.json({ data: { deleted: true } });
  } catch (err) {
    fail(res, err);
  }
};

// PATCH /collections/:id/set-default
export const setDefault = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    await setDefaultCollection(req.params.id, uid(req));
    res.json({ data: { updated: true } });
  } catch (err) {
    fail(res, err);
  }
};

// POST /collections/ensure-default — called on first load, idempotent
export const ensureDefault = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const collection = await ensureDefaultCollection(uid(req));
    res.json({ data: collection });
  } catch (err) {
    fail(res, err);
  }
};

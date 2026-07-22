import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  listVendorCodes,
  createVendorCode,
  setVendorCodeActive,
  deleteVendorCode,
  VendorCodeError,
} from "../services/vendorCode.service";

const fail = (res: Response, err: any) => {
  if (err instanceof VendorCodeError) {
    res.status(400).json({ error: err.message, code: err.code });
    return;
  }
  res.status(500).json({ error: err?.message ?? "Vendor code request failed" });
};

// GET /api/v1/admin/codes
export const adminListCodes = async (
  _req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    res.json({ data: await listVendorCodes() });
  } catch (err) {
    fail(res, err);
  }
};

// POST /api/v1/admin/codes
export const adminCreateCode = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const created = await createVendorCode(req.body ?? {}, req.user!.id);
    res.status(201).json({ data: created });
  } catch (err) {
    fail(res, err);
  }
};

// PATCH /api/v1/admin/codes/:id  { active }
export const adminSetCodeActive = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const active = !!req.body?.active;
    res.json({ data: await setVendorCodeActive(req.params.id, active) });
  } catch (err) {
    fail(res, err);
  }
};

// DELETE /api/v1/admin/codes/:id
export const adminDeleteCode = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    res.json({ data: await deleteVendorCode(req.params.id) });
  } catch (err) {
    fail(res, err);
  }
};

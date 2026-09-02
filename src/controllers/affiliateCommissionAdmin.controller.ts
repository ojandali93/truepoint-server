// affiliateCommissionAdmin.controller.ts
//
// Phase 2 of AUDITS/affiliate-system-plan.md — admin-only. Mounted under
// /api/v1/admin, gated by the same authenticateUser + requireAdmin
// middleware as every other route in affiliate.admin.routes.ts.

import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/user.types";
import {
  getAffiliateCommissionSummary,
  markAffiliatePaid,
} from "../services/affiliateCommissionAdmin.service";

// GET /admin/affiliates/:id/commission-summary
export async function adminGetAffiliateCommissionSummary(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    const data = await getAffiliateCommissionSummary(id);
    res.json({ data });
  } catch (err) {
    res
      .status(errStatus(err, 500))
      .json({ error: errMessage(err, "Failed to load commission summary") });
  }
}

// POST /admin/affiliates/:id/mark-paid
export async function adminMarkAffiliatePaid(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    const body = req.body ?? {};

    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: "amount must be a positive number" });
      return;
    }
    if (!body.method || typeof body.method !== "string" || !body.method.trim()) {
      res.status(400).json({ error: "method is required" });
      return;
    }

    const result = await markAffiliatePaid(id, {
      amount,
      method: body.method,
      paidAt: typeof body.paid_at === "string" ? body.paid_at : undefined,
      note: typeof body.note === "string" ? body.note : null,
      markedBy: req.user?.id ?? null,
    });

    res.json({ data: result });
  } catch (err) {
    res
      .status(errStatus(err, 500))
      .json({ error: errMessage(err, "Failed to record payout") });
  }
}

// ── helpers (matches affiliate.controller.ts's own private convention) ──────

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

function errStatus(err: unknown, fallback: number): number {
  if (typeof err === "object" && err && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return fallback;
}

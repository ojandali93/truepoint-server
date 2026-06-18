import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as FeedbackService from "../services/feedback.service";
import {
  listFeedback as listFeedbackRepo,
  updateFeedbackStatus,
} from "../repositories/feedback.repository";
import { logError } from "../lib/Logger";

// ─── User: submit feedback / support ──────────────────────────────────────────
export const createFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const feedback = await FeedbackService.submitFeedback(
      req.user.id,
      req.body,
    );
    res.status(201).json({ data: feedback });
  } catch (err: any) {
    await logError({
      source: "create-feedback",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Admin: list feedback ─────────────────────────────────────────────────────
export const listFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { category, status } = req.query as Record<string, string>;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const result = await listFeedbackRepo({ category, status, limit, offset });
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "admin-list-feedback",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Admin: update feedback (resolve / reopen / notes) ────────────────────────
export const updateFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { status, admin_notes } = req.body as {
      status?: string;
      admin_notes?: string;
    };
    const updated = await updateFeedbackStatus(req.params.id, {
      status,
      adminNotes: admin_notes,
      resolvedBy: req.user?.id ?? null,
    });
    res.json({ data: updated });
  } catch (err: any) {
    await logError({
      source: "admin-update-feedback",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
    });
    res.status(500).json({ error: err?.message });
  }
};

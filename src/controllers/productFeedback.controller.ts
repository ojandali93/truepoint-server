import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as ProductFeedbackService from "../services/productFeedback.service";
import { logError } from "../lib/Logger";

// ─── User: submit ───────────────────────────────────────────────────────────
export const submitProductFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const feedback = await ProductFeedbackService.submitProductFeedback(
      req.user.id,
      req.body,
    );
    res.status(201).json({ data: feedback });
  } catch (err: any) {
    await logError({
      source: "submit-product-feedback",
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

// ─── User: dismiss ──────────────────────────────────────────────────────────
export const dismissProductFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { feedback_type } = req.body as {
      feedback_type: "periodic" | "cancellation";
    };
    await ProductFeedbackService.dismissProductFeedback(
      req.user.id,
      feedback_type,
    );
    res.status(204).send();
  } catch (err: any) {
    await logError({
      source: "dismiss-product-feedback",
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

// ─── Admin: list ─────────────────────────────────────────────────────────────
export const listProductFeedback = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { feedback_type, cancellation_reason, was_trial } =
      req.query as Record<string, string>;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Number(req.query.offset ?? 0);
    const result = await ProductFeedbackService.listProductFeedback({
      feedbackType: feedback_type as "periodic" | "cancellation" | undefined,
      cancellationReason: cancellation_reason,
      wasTrial:
        was_trial === undefined ? undefined : was_trial === "true",
      limit,
      offset,
    });
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "admin-list-product-feedback",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
    });
    res.status(500).json({ error: err?.message });
  }
};

// ─── Admin: summary (charts) ────────────────────────────────────────────────
export const getProductFeedbackSummary = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const summary = await ProductFeedbackService.getProductFeedbackSummary();
    res.json({ data: summary });
  } catch (err: any) {
    await logError({
      source: "admin-product-feedback-summary",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
    });
    res.status(500).json({ error: err?.message });
  }
};

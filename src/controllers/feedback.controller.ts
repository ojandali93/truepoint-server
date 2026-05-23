import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as FeedbackService from "../services/feedback.service";
import { logError } from "../lib/Logger";

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

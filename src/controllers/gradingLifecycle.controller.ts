// src/controllers/gradingLifecycle.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  getSubmissions,
  getSubmission,
  createSubmission,
  advanceStatus,
  updateSubmission,
  deleteSubmission,
  getPipelineSummary,
  addCardsToSubmission,
  removeCardFromSubmission,
  updateSubmissionCard,
} from "../services/gradingLifecycle.service";
import { logError } from "../lib/Logger";

// Shared error handler — logs the real error server-side, sends a generic message to the client.
const handle = async (
  req: AuthenticatedRequest,
  res: Response,
  fn: () => Promise<any>,
  successStatus = 200,
) => {
  try {
    const data = await fn();
    res.status(successStatus).json({ data });
  } catch (err: any) {
    await logError({
      source: "grading_lifecycle",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query, body: req.body },
    });
    res.status(500).json({ error: "Something went wrong" });
  }
};

// ─── Envelopes ──────────────────────────────────────────────────────────────

// GET /grading/submissions
export const listSubmissions = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () => getSubmissions(req.user.id, req.query.status as any));

// GET /grading/submissions/summary
export const getSummary = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () => getPipelineSummary(req.user.id));

// GET /grading/submissions/:id
export const getOne = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const submission = await getSubmission(req.user.id, req.params.id);
    if (!submission) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json({ data: submission });
  } catch (err: any) {
    await logError({
      source: "grading_lifecycle",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params },
    });
    res.status(500).json({ error: "Something went wrong" });
  }
};

// POST /grading/submissions
export const create = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () => createSubmission(req.user.id, req.body), 201);

// POST /grading/submissions/:id/advance
export const advance = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () => advanceStatus(req.user.id, req.params.id, req.body));

// PATCH /grading/submissions/:id
export const update = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () =>
    updateSubmission(req.user.id, req.params.id, req.body),
  );

// DELETE /grading/submissions/:id
export const remove = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, async () => {
    await deleteSubmission(req.user.id, req.params.id);
    return { deleted: true };
  });

// ─── Line items ─────────────────────────────────────────────────────────────

// POST /grading/submissions/:id/cards   body: { cards: CreateCardInput[] }
export const addCards = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () =>
    addCardsToSubmission(req.user.id, req.params.id, req.body?.cards ?? []),
  );

// PATCH /grading/submission-cards/:cardId
export const updateCard = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, () =>
    updateSubmissionCard(req.user.id, req.params.cardId, req.body),
  );

// DELETE /grading/submission-cards/:cardId
export const removeCard = (req: AuthenticatedRequest, res: Response) =>
  handle(req, res, async () => {
    await removeCardFromSubmission(req.user.id, req.params.cardId);
    return { deleted: true };
  });

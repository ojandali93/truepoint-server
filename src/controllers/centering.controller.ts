import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as CenteringService from "../services/centering.service";
import { logError } from "../lib/Logger";

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[CenteringController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

// Live analysis — no DB write, returns calculated results instantly
// Used by the frontend during interactive line adjustment
export const analyzeOnly = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = CenteringService.analyzeOnly(req.body);
    res.json({ data: result });
  } catch (err: any) {
    await logError({
      source: "analyze-only", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// Full save — calculates + persists, returns the saved report with its ID
export const analyzeAndSave = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const report = await CenteringService.analyzeAndSave(req.user.id, req.body);
    res.status(201).json({ data: report });
  } catch (err: any) {
    await logError({
      source: "analyze-and-save", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getMyReports = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const reports = await CenteringService.getMyReports(req.user.id, page);
    res.json({ data: reports });
  } catch (err: any) {
    await logError({
      source: "get-my-reports", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getReportById = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const report = await CenteringService.getReportById(
      req.params.reportId,
      req.user.id,
    );
    res.json({ data: report });
  } catch (err: any) {
    await logError({
      source: "get-report-by-id", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getReportsForCard = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const reports = await CenteringService.getReportsForCard(
      req.user.id,
      req.params.cardId,
    );
    res.json({ data: reports });
  } catch (err: any) {
    await logError({
      source: "get-reports-for-card", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

export const deleteReport = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await CenteringService.removeReport(req.params.reportId, req.user.id);
    res.status(204).send();
  } catch (err: any) {
    await logError({
      source: "delete-report", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

// src/controllers/aiGrading.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { analyzeCardForGrading, GradingAnalysis } from "../lib/geminiClient";
import { supabaseAdmin } from "../lib/supabase";

const handleError = (res: Response, err: unknown) => {
  console.error("[AIGrading]", err);
  res.status(500).json({
    error: err instanceof Error ? err.message : "Internal server error",
  });
};

// ─── Recommendation logic ─────────────────────────────────────────────────────

const computeRecommendation = (
  analysis: GradingAnalysis,
): { recommendation: "grade" | "skip" | "borderline"; reason: string } => {
  const { centering, corners, edges, surface, predictions } = analysis;
  const avg = (centering + corners + edges + surface) / 4;
  const psaGrade = predictions.psa.grade;

  if (predictions.bgs.isBlackLabel) {
    return {
      recommendation: "grade",
      reason:
        "All four subgrades scored 10 — potential BGS Black Label. Submit immediately. Exceptionally rare.",
    };
  }
  if (predictions.cgc.isPristine || predictions.tag.isPristine) {
    return {
      recommendation: "grade",
      reason: `Predicted ${predictions.cgc.isPristine ? "CGC Pristine 10" : "TAG Pristine"} — an elite designation. Strong grading candidate.`,
    };
  }
  if (psaGrade === 10 && avg >= 9.5) {
    return {
      recommendation: "grade",
      reason: `Predicted PSA 10 with strong subgrades (avg ${avg.toFixed(2)}). Excellent candidate — high potential ROI.`,
    };
  }
  if (psaGrade >= 9 && avg >= 9.0) {
    return {
      recommendation: "grade",
      reason: `Predicted PSA ${psaGrade} with solid subgrades (avg ${avg.toFixed(2)}). Worth grading if the card has market value.`,
    };
  }
  if (psaGrade >= 8 && Math.min(centering, corners, edges, surface) >= 7.5) {
    return {
      recommendation: "borderline",
      reason: `Predicted PSA ${psaGrade}. Consider the card's value vs grading cost. Improving image quality may refine this estimate.`,
    };
  }
  return {
    recommendation: "skip",
    reason: `Predicted PSA ${psaGrade} with average subgrades of ${avg.toFixed(2)}. Grading cost likely exceeds value added at this grade.`,
  };
};

// ─── POST /grading/ai-analyze ─────────────────────────────────────────────────
// Responds IMMEDIATELY with a reportId, then processes in background.
// Gemini can take 30-120 seconds — we never make the client wait.

export const analyzeCard = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { frontBase64, frontMime, backBase64, backMime, cardName, setName } =
      req.body;

    if (!frontBase64 || !backBase64) {
      res
        .status(400)
        .json({ error: "Both frontBase64 and backBase64 are required" });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res
        .status(503)
        .json({ error: "AI grading is not configured on this server" });
      return;
    }

    // Create a pending report immediately so we have an ID to return
    const { data: pendingReport, error: createError } = await supabaseAdmin
      .from("ai_grading_reports")
      .insert({
        user_id: req.user.id,
        card_name: cardName ?? null,
        set_name: setName ?? null,
        status: "processing",
        // placeholder values — will be updated when Gemini completes
        centering: 0,
        corners: 0,
        edges: 0,
        surface: 0,
        predictions: {},
        confidence: 0,
        recommendation: "skip",
        recommendation_reason: "Processing...",
        issues: [],
        strengths: [],
      })
      .select("id")
      .single();

    if (createError || !pendingReport) {
      res.status(500).json({ error: "Failed to create grading report" });
      return;
    }

    const reportId = pendingReport.id;
    console.log(
      `[AIGrading] Created pending report ${reportId} for user ${req.user.id}${cardName ? ` — ${cardName}` : ""}`,
    );

    // Respond immediately — client doesn't wait for Gemini
    res.json({
      data: {
        reportId,
        status: "processing",
        message:
          "Your grading report is being processed. Check My Reports in a few minutes.",
      },
    });

    // Process in background — no await, runs after response is sent
    setImmediate(async () => {
      try {
        console.log(
          `[AIGrading] Starting Gemini analysis for report ${reportId}...`,
        );

        const analysis = await analyzeCardForGrading(
          frontBase64,
          frontMime ?? "image/jpeg",
          backBase64,
          backMime ?? "image/jpeg",
          cardName,
          setName,
        );

        const { recommendation, reason } = computeRecommendation(analysis);

        console.log(
          `[AIGrading] Report ${reportId} complete — PSA: ${analysis.predictions.psa.grade}, BGS: ${analysis.predictions.bgs.label}`,
        );

        // Update the pending report with real results
        await supabaseAdmin
          .from("ai_grading_reports")
          .update({
            status: "completed",
            centering: analysis.centering,
            corners: analysis.corners,
            edges: analysis.edges,
            surface: analysis.surface,
            centering_ratio_front: analysis.centeringRatio.front,
            centering_ratio_back: analysis.centeringRatio.back,
            predictions: analysis.predictions,
            issues: analysis.issues,
            strengths: analysis.strengths,
            confidence: analysis.confidence,
            notes: analysis.notes,
            recommendation,
            recommendation_reason: reason,
          })
          .eq("id", reportId);

        console.log(`[AIGrading] Report ${reportId} saved to DB`);
      } catch (err: any) {
        console.error(
          `[AIGrading] Background analysis failed for report ${reportId}:`,
          err?.message,
        );
        // Mark as failed so user knows something went wrong
        await supabaseAdmin
          .from("ai_grading_reports")
          .update({
            status: "failed",
            recommendation_reason: `Analysis failed: ${err?.message ?? "Unknown error"}`,
          })
          .eq("id", reportId);
      }
    });
  } catch (err) {
    handleError(res, err);
  }
};

// ─── GET /grading/ai-reports ──────────────────────────────────────────────────

export const getReports = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from("ai_grading_reports")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data: data ?? [] });
  } catch (err) {
    handleError(res, err);
  }
};

// ─── DELETE /grading/ai-reports/:id ──────────────────────────────────────────

export const deleteReport = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    await supabaseAdmin
      .from("ai_grading_reports")
      .delete()
      .eq("id", req.params.id)
      .eq("user_id", req.user.id);
    res.json({ data: { deleted: true } });
  } catch (err) {
    handleError(res, err);
  }
};

// ─── src/routes/aiGrading.routes.ts ──────────────────────────────────────────

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as AIG from "../controllers/aiGrading.controller";

const router = Router();
router.use(authenticateUser as any);

router.post("/ai-analyze", writeLimiter, AIG.analyzeCard as any);
router.get("/ai-reports", standardLimiter, AIG.getReports as any);
router.delete("/ai-reports/:id", writeLimiter, AIG.deleteReport as any);

export default router;

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { analyzeCardForGrading, GradingAnalysis } from "../lib/geminiClient";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { handlePlanError } from "../middleware/plan.middleware";
import { checkMonthlyLimit, requireFeature } from "../services/plan.service";

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
    const {
      frontBase64,
      frontMime,
      backBase64,
      backMime,
      cardName,
      setName,
      submissionCardId, // optional — when provided, link the report to a submission card
    } = req.body;

    // Upload images to Supabase Storage bucket "Ai Grading Images"
    const uploadImage = async (
      base64: string,
      mime: string,
      side: "front" | "back",
    ): Promise<string | null> => {
      try {
        // Plan gate
        await requireFeature(req.user.id, "ai_grading", req.user.role);
        await checkMonthlyLimit(req.user.id, "ai_grading_reports", req.user.role);

        const ext =
          mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
        const path = `${req.user.id}/${Date.now()}_${side}.${ext}`;
        const buffer = Buffer.from(base64, "base64");

        const { error } = await supabaseAdmin.storage
          .from("Ai Grading Images")
          .upload(path, buffer, { contentType: mime, upsert: false });

        if (error) {
          console.error(
            `[AIGrading] Storage upload failed (${side}):`,
            error.message,
          );
          return null;
        }

        const { data } = supabaseAdmin.storage
          .from("Ai Grading Images")
          .getPublicUrl(path);

        return data.publicUrl;
      } catch (err: any) {
        if (handlePlanError(res, err)) return null;
        await logError({
          source: "upload-image", // ← change per controller
          message: err?.message ?? "Unknown error",
          error: err,
          userId: (req as any)?.userId ?? null,
          requestPath: req.path,
          requestMethod: req.method,
          metadata: { params: req.params, query: req.query },
        });
        res.status(500).json({ error: err?.message });
        return null;
      }
    };

    const [frontImage, backImage] = await Promise.all([
      uploadImage(frontBase64, frontMime ?? "image/jpeg", "front"),
      uploadImage(backBase64, backMime ?? "image/jpeg", "back"),
    ]);

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
        front_image: frontImage,
        back_image: backImage,
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

    // If this report was triggered from a submission card, link it.
    // We verify ownership through the parent envelope's user_id before writing.
    if (submissionCardId) {
      const { data: ownership } = await supabaseAdmin
        .from("submission_cards")
        .select("id, grading_submissions!inner(user_id)")
        .eq("id", submissionCardId)
        .maybeSingle();

      if (
        ownership &&
        (ownership.grading_submissions as any).user_id === req.user.id
      ) {
        await supabaseAdmin
          .from("submission_cards")
          .update({ ai_grading_report_id: reportId })
          .eq("id", submissionCardId);
      } else {
        console.warn(
          `[AIGrading] submissionCardId ${submissionCardId} ownership mismatch — skipping link`,
        );
      }
    }

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
            overall_score: analysis.overallScore,
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
  } catch (err: any) {
    await logError({
      source: "analyze-card", // ← change per controller
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
  } catch (err: any) {
    await logError({
      source: "get-reports", // ← change per controller
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

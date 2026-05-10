import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { analyzeCardForGrading, GradingAnalysis } from "../lib/geminiClient";
import { supabaseAdmin } from "../lib/supabase";

const handleError = (res: Response, err: unknown) => {
  console.error("[AIGrading]", err);
  res
    .status(500)
    .json({
      error: err instanceof Error ? err.message : "Internal server error",
    });
};

// ─── Recommendation logic ─────────────────────────────────────────────────────

const computeRecommendation = (
  analysis: GradingAnalysis,
): { recommendation: "grade" | "skip" | "borderline"; reason: string } => {
  const { centering, corners, edges, surface, predictions } = analysis;
  const avg = (centering + corners + edges + surface) / 4;
  const lowest = Math.min(centering, corners, edges, surface);
  const psaGrade = predictions.psa.grade;

  // Strong grade candidates
  if (psaGrade === 10 && avg >= 9.5) {
    return {
      recommendation: "grade",
      reason: `Predicted PSA 10 with strong subgrades (avg ${avg.toFixed(2)}). Excellent grading candidate — high potential ROI.`,
    };
  }

  if (predictions.bgs.isBlackLabel) {
    return {
      recommendation: "grade",
      reason:
        "All four subgrades scored 10 — potential BGS Black Label. Submit immediately. This is exceptionally rare.",
    };
  }

  if (predictions.cgc.isPristine || predictions.tag.isPristine) {
    return {
      recommendation: "grade",
      reason: `Predicted ${predictions.cgc.isPristine ? "CGC Pristine 10" : "TAG Pristine"} — an elite designation. Strong grading candidate.`,
    };
  }

  if (psaGrade >= 9 && avg >= 9.0) {
    return {
      recommendation: "grade",
      reason: `Predicted PSA ${psaGrade} with solid subgrades (avg ${avg.toFixed(2)}). Worth grading if the card has market value.`,
    };
  }

  // Borderline
  if (psaGrade >= 8 && lowest >= 7.5) {
    return {
      recommendation: "borderline",
      reason: `Predicted PSA ${psaGrade}. ${
        lowest < 8.5
          ? `Weakest subgrade is ${Math.min(centering, corners, edges, surface).toFixed(1)} — address condition issues before submitting.`
          : "Could grade well on a good day. Consider the card's value vs grading cost before submitting."
      }`,
    };
  }

  // Skip
  return {
    recommendation: "skip",
    reason: `Predicted PSA ${psaGrade} with average subgrades of ${avg.toFixed(2)}. Grading cost likely exceeds value added at this grade. Keep raw or find a better copy.`,
  };
};

// ─── POST /grading/ai-analyze ─────────────────────────────────────────────────

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

    const validMimes = ["image/jpeg", "image/png", "image/webp"];
    if (
      !validMimes.includes(frontMime ?? "image/jpeg") ||
      !validMimes.includes(backMime ?? "image/jpeg")
    ) {
      res
        .status(400)
        .json({
          error:
            "Invalid mimeType. Must be image/jpeg, image/png, or image/webp",
        });
      return;
    }

    console.log(
      `[AIGrading] Analyzing${cardName ? ` ${cardName}` : ""} (front + back) for user ${req.user.id}`,
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
      `[AIGrading] Result — PSA: ${analysis.predictions.psa.grade}, BGS: ${analysis.predictions.bgs.label}, recommendation: ${recommendation}`,
    );

    // Save report to DB
    const { data: report, error: saveError } = await supabaseAdmin
      .from("ai_grading_reports")
      .insert({
        user_id: req.user.id,
        card_name: cardName ?? null,
        set_name: setName ?? null,
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
      .select("id")
      .single();

    if (saveError) {
      console.error("[AIGrading] Failed to save report:", saveError.message);
    }

    res.json({
      data: {
        ...analysis,
        recommendation,
        recommendationReason: reason,
        reportId: report?.id ?? null,
      },
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

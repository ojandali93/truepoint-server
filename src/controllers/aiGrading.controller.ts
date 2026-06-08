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
  const { tpScore, tpDisplay, sub, predictions } = analysis;
  const minSub = Math.min(sub.centering, sub.corners, sub.edges, sub.surface);

  const psa = predictions.find((p) => p.company === "PSA");
  const psaLikely = psa?.likely ?? "—";

  const hasNote = (company: string) =>
    predictions.find((p) => p.company === company)?.note != null;

  // All four subgrades essentially perfect → BGS Black Label territory.
  if (minSub >= 99) {
    return {
      recommendation: "grade",
      reason:
        "All four subgrades scored gem (99+/100) — potential BGS Black Label. Submit immediately. Exceptionally rare.",
    };
  }
  // Elite designations flagged by the mapper.
  if (hasNote("CGC") || hasNote("SGC")) {
    return {
      recommendation: "grade",
      reason: `TP score ${tpDisplay} — Pristine/Gold-Label designation in play. Strong grading candidate.`,
    };
  }
  // PSA 10 in play with strong everything.
  if (tpScore >= 96 && minSub >= 95) {
    return {
      recommendation: "grade",
      reason: `TP score ${tpDisplay} with strong subgrades — PSA 10 in play (likely PSA ${psaLikely}). Excellent candidate, high potential ROI.`,
    };
  }
  // Solid mint candidate.
  if (tpScore >= 90) {
    return {
      recommendation: "grade",
      reason: `TP score ${tpDisplay} (likely PSA ${psaLikely}) with solid subgrades. Worth grading if the card has market value.`,
    };
  }
  // Borderline — depends on card value vs grading cost.
  if (tpScore >= 80 && minSub >= 75) {
    return {
      recommendation: "borderline",
      reason: `TP score ${tpDisplay} (likely PSA ${psaLikely}). Weigh the card's value against grading cost. Better photos may sharpen this estimate.`,
    };
  }
  return {
    recommendation: "skip",
    reason: `TP score ${tpDisplay} (likely PSA ${psaLikely}), weakest subgrade ${(
      minSub / 10
    ).toFixed(1)}. Grading cost likely exceeds value added at this grade.`,
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
      inventoryId, // optional — when provided, link the report to an inventory item
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
        await checkMonthlyLimit(
          req.user.id,
          "ai_grading_reports",
          req.user.role,
        );

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
        inventory_id: inventoryId ?? null,
      })
      .select("id")
      .single();

    if (createError || !pendingReport) {
      res.status(500).json({ error: "Failed to create grading report" });
      return;
    }

    const reportId = pendingReport.id;

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
        const analysis = await analyzeCardForGrading(
          frontBase64,
          frontMime ?? "image/jpeg",
          backBase64,
          backMime ?? "image/jpeg",
          cardName,
          setName,
        );

        const { recommendation, reason } = computeRecommendation(analysis);

        // Update the pending report with real results
        await supabaseAdmin
          .from("ai_grading_reports")
          .update({
            status: "completed",
            overall_score: analysis.tpDisplay, // TP score, 1–10 scale (e.g. 9.6)
            centering: analysis.sub.centering / 10, // back to 1–10 for the existing column
            corners: analysis.sub.corners / 10,
            edges: analysis.sub.edges / 10,
            surface: analysis.sub.surface / 10,
            tp_score: analysis.tpScore,
            centering_ratio_front: analysis.centeringRatio.front,
            centering_ratio_back: analysis.centeringRatio.back,
            predictions: analysis.predictions, // now an array: { company, likely, range, note }
            issues: analysis.issues,
            strengths: analysis.strengths,
            confidence: analysis.confidence,
            notes: analysis.notes,
            recommendation,
            recommendation_reason: reason,
          })
          .eq("id", reportId);
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
      .select(
        `
    *,
    submission_card:submission_cards!ai_grading_report_id (
      id,
      submission_id,
      card_name
    )
  `,
      )
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

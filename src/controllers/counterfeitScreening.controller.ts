// src/controllers/counterfeitScreening.controller.ts
//
// Counterfeit Screening, Phase 1 (AUDITS/counterfeit-screening-plan.md).
// Mirrors aiGrading.controller.ts's async-report lifecycle exactly: upload
// images -> insert a "processing" row -> respond immediately with the
// report id -> run the actual analysis in the background (setImmediate,
// no await) -> update the row to "completed"/"failed" when that finishes.
// Same reason as AI grading: the Gemini call runs long enough that the
// client can't sit on an open HTTP connection waiting for it.

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { handlePlanError } from "../middleware/plan.middleware";
import { checkMonthlyLimit, requireFeature } from "../services/plan.service";
import { screenCardForCounterfeits } from "../services/counterfeitScreening.service";

const BUCKET = "Counterfeit Screening Images";

export const screenCard = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const {
      frontBase64,
      frontMime,
      backBase64,
      backMime,
      backlitBase64,
      backlitMime,
    } = req.body;

    if (!frontBase64 || !backBase64) {
      res
        .status(400)
        .json({ error: "Both frontBase64 and backBase64 are required" });
      return;
    }

    if (!process.env.GEMINI_API_KEY) {
      res
        .status(503)
        .json({ error: "Counterfeit screening is not configured on this server" });
      return;
    }

    const uploadImage = async (
      base64: string,
      mime: string,
      label: "front" | "back" | "backlit",
    ): Promise<string | null> => {
      try {
        // Plan gate — same pattern and same "always passes at starter,
        // the monthly cap is the real enforcement" shape as AI grading.
        await requireFeature(req.user.id, "counterfeit_screening", req.user.role);
        await checkMonthlyLimit(
          req.user.id,
          "counterfeit_screening_reports",
          req.user.role,
        );

        const ext =
          mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg";
        const path = `${req.user.id}/${Date.now()}_${label}.${ext}`;
        const buffer = Buffer.from(base64, "base64");

        const { error } = await supabaseAdmin.storage
          .from(BUCKET)
          .upload(path, buffer, { contentType: mime, upsert: false });

        if (error) {
          console.error(
            `[CounterfeitScreening] Storage upload failed (${label}):`,
            error.message,
          );
          return null;
        }

        const { data } = supabaseAdmin.storage.from(BUCKET).getPublicUrl(path);
        return data.publicUrl;
      } catch (err: any) {
        if (handlePlanError(res, err)) return null;
        await logError({
          source: "counterfeit-screening-upload-image",
          message: err?.message ?? "Unknown error",
          error: err,
          userId: req.user.id,
          requestPath: req.path,
          requestMethod: req.method,
          metadata: { label },
        });
        res.status(500).json({ error: err?.message });
        return null;
      }
    };

    const [frontImage, backImage, backlitImage] = await Promise.all([
      uploadImage(frontBase64, frontMime ?? "image/jpeg", "front"),
      uploadImage(backBase64, backMime ?? "image/jpeg", "back"),
      backlitBase64
        ? uploadImage(backlitBase64, backlitMime ?? "image/jpeg", "backlit")
        : Promise.resolve(null),
    ]);

    // A plan/limit error already sent its own response inside uploadImage.
    if (res.headersSent) return;

    const { data: pendingReport, error: createError } = await supabaseAdmin
      .from("counterfeit_screening_reports")
      .insert({
        user_id: req.user.id,
        status: "processing",
        front_image: frontImage,
        back_image: backImage,
        backlit_image: backlitImage,
        backlit_included: !!backlitBase64,
      })
      .select("id")
      .single();

    if (createError || !pendingReport) {
      res.status(500).json({ error: "Failed to create screening report" });
      return;
    }

    const reportId = pendingReport.id;

    // Respond immediately — client doesn't wait for Gemini.
    res.json({
      data: {
        reportId,
        status: "processing",
        message: "Your screening report is being processed.",
      },
    });

    // Process in background.
    setImmediate(async () => {
      try {
        const result = await screenCardForCounterfeits({
          frontBase64,
          frontMime: frontMime ?? "image/jpeg",
          backBase64,
          backMime: backMime ?? "image/jpeg",
          backlitBase64,
          backlitMime,
        });

        await supabaseAdmin
          .from("counterfeit_screening_reports")
          .update({
            status: "completed",
            identified_card_name: result.identifiedCard.name,
            identified_set_name: result.identifiedCard.setName,
            identified_card_number: result.identifiedCard.cardNumber,
            match_confidence: result.identifiedCard.matchConfidence,
            reference_image_used: result.referenceImageUsed,
            findings: result.analysis.findings,
            overall_confidence: result.analysis.overallConfidence,
            concern_count: result.concernCount,
            top_line_result: result.topLineResult,
            notes: result.analysis.notes,
            updated_at: new Date().toISOString(),
          })
          .eq("id", reportId);
      } catch (err: any) {
        console.error(
          `[CounterfeitScreening] Background analysis failed for report ${reportId}:`,
          err?.message,
        );
        await logError({
          source: "counterfeit-screening-analysis",
          message: err?.message ?? "Unknown error",
          error: err,
          userId: req.user.id,
          requestPath: "",
          requestMethod: "",
          metadata: { reportId },
        });
        await supabaseAdmin
          .from("counterfeit_screening_reports")
          .update({
            status: "failed",
            // User-facing-safe message only — never the raw error, which
            // can carry request/response internals.
            failure_reason: "Analysis failed — please try again.",
            updated_at: new Date().toISOString(),
          })
          .eq("id", reportId);
      }
    });
  } catch (err: any) {
    await logError({
      source: "counterfeit-screen-card",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
};

export const getReports = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { data, error } = await supabaseAdmin
      .from("counterfeit_screening_reports")
      .select("*")
      .eq("user_id", req.user.id)
      .order("created_at", { ascending: false })
      .limit(50);

    if (error) throw error;
    res.json({ data: data ?? [] });
  } catch (err: any) {
    await logError({
      source: "counterfeit-get-reports",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: {},
    });
    res.status(500).json({ error: err?.message });
  }
};

export const deleteReport = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin
      .from("counterfeit_screening_reports")
      .delete()
      .eq("id", id)
      .eq("user_id", req.user.id);

    if (error) throw error;
    res.json({ data: { success: true } });
  } catch (err: any) {
    await logError({
      source: "counterfeit-delete-report",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params },
    });
    res.status(500).json({ error: err?.message });
  }
};

// src/services/gradingComparison.service.ts
//
// Dual-engine grading comparison (AUDITS/dual-engine-grading-plan.md, Part A).
// Runs Ximilar's card-grader alongside our own Gemini pipeline, admin-only,
// behind the dual_engine_grading flag. Owns the whole lifecycle: insert a
// 'processing' row immediately (so the client has something to poll from the
// start), submit to Ximilar, poll to DONE/timeout, update the row.
//
// Deliberately NOT awaited alongside analyzeCardForGrading in the controller
// — this runs as its own independent async path so a slow/stuck Ximilar job
// can never delay our own report completing. Two engines, two completion
// times, never coupled.

import { submitCardGrade, pollCardGrade, type XimilarGradeResult } from "../lib/ximilarClient";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 45_000;

const XIMILAR_GRADE_CREDIT_COST = Number(
  process.env.XIMILAR_GRADE_CREDIT_COST ?? "100",
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntilDone(
  requestId: string,
  timeoutMs: number,
): Promise<{ result: XimilarGradeResult | null; timedOut: boolean }> {
  const startedAt = Date.now();
  for (;;) {
    if (Date.now() - startedAt > timeoutMs) {
      return { result: null, timedOut: true };
    }
    await sleep(POLL_INTERVAL_MS);
    const result = await pollCardGrade(requestId);
    if (result) return { result, timedOut: false };
    // still processing — loop again until timeout
  }
}

/**
 * Fire-and-forget from the controller. Never throws — every outcome (success,
 * Ximilar error, or our own timeout) is written to the comparison row so the
 * client polling it always sees a terminal state eventually, never silence.
 */
export async function runGradingComparison(
  aiGradingReportId: string,
  userId: string,
  frontBase64: string,
  backBase64: string,
): Promise<void> {
  const startedAt = Date.now();

  const { data: pending, error: insertError } = await supabaseAdmin
    .from("grading_engine_comparisons")
    .insert({
      ai_grading_report_id: aiGradingReportId,
      user_id: userId,
      status: "processing",
      ximilar_credits: XIMILAR_GRADE_CREDIT_COST,
    })
    .select("id")
    .single();

  if (insertError || !pending) {
    await logError({
      source: "grading-comparison",
      message: `Failed to create comparison row: ${insertError?.message ?? "unknown"}`,
      error: insertError,
      userId,
      requestPath: "",
      requestMethod: "",
      metadata: { aiGradingReportId },
    });
    return;
  }

  const comparisonId = pending.id;

  try {
    const requestId = await submitCardGrade(frontBase64, backBase64);
    await supabaseAdmin
      .from("grading_engine_comparisons")
      .update({ ximilar_request_id: requestId, updated_at: new Date().toISOString() })
      .eq("id", comparisonId);

    const { result, timedOut } = await pollUntilDone(requestId, POLL_TIMEOUT_MS);
    const latencyMs = Date.now() - startedAt;

    if (timedOut || !result) {
      await supabaseAdmin
        .from("grading_engine_comparisons")
        .update({
          status: "timed_out",
          ximilar_error: `Timed out after ${POLL_TIMEOUT_MS}ms waiting for Ximilar`,
          ximilar_latency_ms: latencyMs,
          updated_at: new Date().toISOString(),
        })
        .eq("id", comparisonId);
      return;
    }

    await supabaseAdmin
      .from("grading_engine_comparisons")
      .update({
        status: "completed",
        ximilar_raw: result.raw,
        ximilar_front_grades: result.front?.grades ?? null,
        ximilar_back_grades: result.back?.grades ?? null,
        ximilar_overall: result.overall,
        ximilar_centering_ratio: {
          front: result.front?.centering
            ? { leftRight: result.front.centering.leftRight, topBottom: result.front.centering.topBottom }
            : null,
          back: result.back?.centering
            ? { leftRight: result.back.centering.leftRight, topBottom: result.back.centering.topBottom }
            : null,
        },
        ximilar_latency_ms: latencyMs,
        updated_at: new Date().toISOString(),
      })
      .eq("id", comparisonId);
  } catch (err: any) {
    const latencyMs = Date.now() - startedAt;
    await supabaseAdmin
      .from("grading_engine_comparisons")
      .update({
        status: "failed",
        ximilar_error: (err?.message ?? "Unknown Ximilar error").slice(0, 500),
        ximilar_latency_ms: latencyMs,
        updated_at: new Date().toISOString(),
      })
      .eq("id", comparisonId);

    await logError({
      source: "grading-comparison",
      message: err?.message ?? "Ximilar comparison failed",
      error: err,
      userId,
      requestPath: "",
      requestMethod: "",
      metadata: { aiGradingReportId, comparisonId },
    });
  }
}

/** Fetch the comparison row for a report, if one exists — for the client's own polling. */
export async function getComparisonForReport(
  aiGradingReportId: string,
  userId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("grading_engine_comparisons")
    .select("*")
    .eq("ai_grading_report_id", aiGradingReportId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

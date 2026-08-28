// src/services/productFeedback.service.ts
//
// See FEEDBACK_DESIGN.md and productFeedback.repository.ts's header for the
// architecture. This layer's one job: route a submit/dismiss to the right
// repository writes depending on feedback_type, since periodic (Flow A) and
// cancellation (Flow B) update completely different state.

import * as ProductFeedbackRepo from "../repositories/productFeedback.repository";

type Platform = "ios" | "android" | "web";

export interface SubmitPeriodicInput {
  feedbackType: "periodic";
  rating: number;
  freeText?: string;
  triggerContext: string;
  appVersion?: string;
  platform?: Platform;
}

export interface SubmitCancellationInput {
  feedbackType: "cancellation";
  cancellationReasons: string[];
  freeText?: string;
  triggerContext: string;
  appVersion?: string;
  platform?: Platform;
}

export type SubmitProductFeedbackInput =
  | SubmitPeriodicInput
  | SubmitCancellationInput;

export const submitProductFeedback = async (
  userId: string,
  input: SubmitProductFeedbackInput,
) => {
  if (input.feedbackType === "periodic") {
    const row = await ProductFeedbackRepo.insertProductFeedback({
      userId,
      feedbackType: "periodic",
      rating: input.rating,
      freeText: input.freeText,
      triggerContext: input.triggerContext,
      appVersion: input.appVersion,
      platform: input.platform,
    });
    await ProductFeedbackRepo.recordFlowAResponse(userId);
    return row;
  }

  // cancellation — was_trial is captured from subscriptions at the moment
  // cancellation was requested (billing.service.ts / revenuecat.service.ts),
  // not asked of or trusted from the client. Covers both Flow B1 (web,
  // answered synchronously inside the cancel flow) and Flow B2 (mobile,
  // answered later from the pending marker) — same endpoint, same resolve.
  const gateState = await ProductFeedbackRepo.getFlowB2GateState(userId);
  const row = await ProductFeedbackRepo.insertProductFeedback({
    userId,
    feedbackType: "cancellation",
    cancellationReasons: input.cancellationReasons,
    wasTrial: gateState.wasTrial,
    freeText: input.freeText,
    triggerContext: input.triggerContext,
    appVersion: input.appVersion,
    platform: input.platform,
  });
  await ProductFeedbackRepo.resolveFlowB2(userId);
  return row;
};

export const dismissProductFeedback = async (
  userId: string,
  feedbackType: "periodic" | "cancellation",
): Promise<void> => {
  if (feedbackType === "periodic") {
    await ProductFeedbackRepo.recordFlowADismissal(userId);
  } else {
    // Flow B1 skip or Flow B2 dismiss — one dismiss = never re-ask for THIS
    // cancellation. No product_feedback row (nothing was said).
    await ProductFeedbackRepo.resolveFlowB2(userId);
  }
};

// ─── Admin ──────────────────────────────────────────────────────────────────

export const listProductFeedback = ProductFeedbackRepo.listProductFeedback;

export const getProductFeedbackSummary = async () => {
  const [cancellationReasonBreakdown, ratingTrend] = await Promise.all([
    ProductFeedbackRepo.getCancellationReasonBreakdown(),
    ProductFeedbackRepo.getRatingTrend(),
  ]);
  return { cancellationReasonBreakdown, ratingTrend };
};

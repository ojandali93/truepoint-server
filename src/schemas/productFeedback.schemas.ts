import { z } from "zod";

// Matches the CHECK constraint in migrations/2026-08-28_product_feedback.sql
// exactly — keep these in sync if the allowed set ever changes.
export const CANCELLATION_REASONS = [
  "too_expensive",
  "missing_feature",
  "didnt_work_as_expected",
  "not_using_enough",
  "switched_to_another_app",
  "just_exploring",
  "other",
] as const;

const platformSchema = z.enum(["ios", "android", "web"]);

const periodicSchema = z.object({
  feedback_type: z.literal("periodic"),
  rating: z.number().int().min(1).max(5),
  free_text: z.string().max(2000).optional(),
  trigger_context: z.string().min(1).max(100),
  app_version: z.string().max(50).optional(),
  platform: platformSchema.optional(),
});

const cancellationSchema = z.object({
  feedback_type: z.literal("cancellation"),
  // Multi-select — Flow B2's reason sheet lets more than one chip be picked.
  cancellation_reasons: z.array(z.enum(CANCELLATION_REASONS)).min(1).max(7),
  free_text: z.string().max(2000).optional(),
  trigger_context: z.string().min(1).max(100),
  app_version: z.string().max(50).optional(),
  platform: platformSchema.optional(),
});

export const submitProductFeedbackSchema = z.discriminatedUnion("feedback_type", [
  periodicSchema,
  cancellationSchema,
]);

export const dismissProductFeedbackSchema = z.object({
  feedback_type: z.enum(["periodic", "cancellation"]),
  trigger_context: z.string().max(100).optional(),
});

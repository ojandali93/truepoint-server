import { z } from "zod";

export const createFeedbackSchema = z.object({
  category: z.enum(["bug", "feature", "general", "other"]),
  message: z.string().min(1, "Message is required").max(5000),
  app_version: z.string().max(50).optional(),
  platform: z.string().max(20).optional(),
});

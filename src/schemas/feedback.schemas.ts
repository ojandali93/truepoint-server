import { z } from "zod";

export const createFeedbackSchema = z.object({
  category: z.enum(["bug", "feature", "general", "support", "other"]),
  message: z.string().min(1, "Message is required").max(5000),
  app_version: z.string().max(50).optional(),
  platform: z.string().max(20).optional(),
  // Optional contact email — lets a user give a reply-to address even if their
  // account email differs (or for follow-up on support requests).
  contact_email: z.string().email().max(200).optional(),
});

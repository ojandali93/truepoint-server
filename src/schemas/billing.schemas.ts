import { z } from "zod";

export const createCheckoutSessionSchema = z.object({
  plan: z.enum(["collector", "pro"]),
});

export const verifySessionSchema = z.object({
  sessionId: z.string().min(1, "Session ID is required"),
});

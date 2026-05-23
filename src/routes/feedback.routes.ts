import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { writeLimiter } from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import { createFeedbackSchema } from "../schemas/feedback.schemas";
import * as FeedbackController from "../controllers/feedback.controller";

const router = Router();

router.use(authenticateUser as any);

router.post(
  "/",
  writeLimiter,
  validate(createFeedbackSchema),
  FeedbackController.createFeedback as any,
);

export default router;

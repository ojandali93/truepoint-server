import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { writeLimiter } from "../middleware/rateLimit.middleware";
import { validate } from "../middleware/validate.middleware";
import {
  submitProductFeedbackSchema,
  dismissProductFeedbackSchema,
} from "../schemas/productFeedback.schemas";
import * as ProductFeedbackController from "../controllers/productFeedback.controller";

const router = Router();

router.use(authenticateUser as any);

router.post(
  "/",
  writeLimiter,
  validate(submitProductFeedbackSchema),
  ProductFeedbackController.submitProductFeedback as any,
);

router.post(
  "/dismiss",
  writeLimiter,
  validate(dismissProductFeedbackSchema),
  ProductFeedbackController.dismissProductFeedback as any,
);

export default router;

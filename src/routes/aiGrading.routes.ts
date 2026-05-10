import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { writeLimiter } from "../middleware/rateLimit.middleware";
import * as AIGradingController from "../controllers/aiGrading.controller";

const aiGradingRouter = Router();
aiGradingRouter.use(authenticateUser as any);

// POST /grading/ai-analyze
aiGradingRouter.post(
  "/ai-analyze",
  writeLimiter,
  AIGradingController.analyzeCard as any,
);

export default aiGradingRouter;

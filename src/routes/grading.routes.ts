import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import * as GradingController from "../controllers/grading.controller";

const gradingRouter = Router();
gradingRouter.use(authenticateUser as any);

gradingRouter.get(
  "/arbitrage",
  standardLimiter,
  GradingController.getArbitrage as any,
);

gradingRouter.get(
  "/costs",
  standardLimiter,
  GradingController.getGradingCosts as any,
);

export default gradingRouter;

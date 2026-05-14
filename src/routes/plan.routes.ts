// src/routes/plan.routes.ts

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import { getMyPlan } from "../controllers/plan.controller";

const router = Router();
router.use(authenticateUser as any);

router.get("/me/plan", standardLimiter, getMyPlan as any);

export default router;

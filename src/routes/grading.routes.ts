// src/routes/grading.routes.ts

import { Router } from 'express';
import { authenticateUser } from '../middleware/auth.middleware';
import { standardLimiter } from '../middleware/rateLimit.middleware';
import * as GradingController from '../controllers/grading.controller';

const router = Router();
router.use(authenticateUser as any);

// GET /api/v1/grading/arbitrage
// Returns grading ROI analysis for all raw cards in user's inventory
router.get('/arbitrage', standardLimiter, GradingController.getArbitrage as any);

// GET /api/v1/grading/costs
// Returns grading cost tiers for all companies
router.get('/costs', standardLimiter, GradingController.getGradingCosts as any);

export default router;

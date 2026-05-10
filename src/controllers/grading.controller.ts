// src/controllers/grading.controller.ts

import { Response } from 'express';
import { AuthenticatedRequest } from '../types/user.types';
import { getGradingArbitrage, GRADING_COSTS } from '../services/gradingArbitrage.service';

const handleError = (res: Response, err: unknown) => {
  console.error('[GradingController]', err);
  res.status(500).json({ error: 'Internal server error' });
};

// GET /api/v1/grading/arbitrage
export const getArbitrage = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  try {
    const service = (req.query.service as string) ?? 'PSA';
    const tier    = (req.query.tier as string)    ?? 'value';
    const grade   = (req.query.grade as string)   ?? '10';
    const result = await getGradingArbitrage(req.user.id, service, tier, grade);
    res.json({ data: result });
  } catch (err) { handleError(res, err); }
};

// GET /api/v1/grading/costs
export const getGradingCosts = async (_req: AuthenticatedRequest, res: Response): Promise<void> => {
  res.json({ data: GRADING_COSTS });
};

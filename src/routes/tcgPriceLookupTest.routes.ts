// src/routes/tcgPriceLookupTest.routes.ts
//
// Admin-only. See tcgPriceLookupTest.controller.ts for the reasoning —
// pure read-only diagnostic, isolated from the production graded-price
// pipeline.

import { Router } from "express";

import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import * as TcgPriceLookupTestController from "../controllers/tcgPriceLookupTest.controller";

const router = Router();
router.use(authenticateUser, requireAdmin);

router.post(
  "/tcg-price-lookup-test/search",
  standardLimiter,
  TcgPriceLookupTestController.testSearch as any,
);
router.post(
  "/tcg-price-lookup-test/detail",
  standardLimiter,
  TcgPriceLookupTestController.testDetail as any,
);

export default router;

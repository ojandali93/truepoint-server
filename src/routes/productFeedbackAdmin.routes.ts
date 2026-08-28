// src/routes/productFeedbackAdmin.routes.ts
//
// Admin-only. Mounted under /api/v1/admin in app.ts, same pattern as
// feedbackAdmin.routes.ts (a different, unrelated table — see
// FEEDBACK_DESIGN.md §1.1).
//
//   GET /api/v1/admin/product-feedback           list (filters)
//   GET /api/v1/admin/product-feedback/summary   cancellation-reason
//                                                 breakdown + rating trend

import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import * as ProductFeedbackController from "../controllers/productFeedback.controller";

const router = Router();

router.use(authenticateUser as any, requireAdmin as any);

router.get(
  "/product-feedback",
  ProductFeedbackController.listProductFeedback as any,
);
router.get(
  "/product-feedback/summary",
  ProductFeedbackController.getProductFeedbackSummary as any,
);

export default router;

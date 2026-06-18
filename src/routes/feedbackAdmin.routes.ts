// src/routes/feedbackAdmin.routes.ts
//
// Admin-only feedback endpoints. Mounted under /api/v1/admin in app.ts so they
// sit alongside the other admin routes without touching admin.routes.ts.
//
//   GET   /api/v1/admin/feedback           list (filter by status/category)
//   PATCH /api/v1/admin/feedback/:id       update status / notes

import { Router } from "express";
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import * as FeedbackController from "../controllers/feedback.controller";

const router = Router();

router.use(authenticateUser as any, requireAdmin as any);

router.get("/feedback", FeedbackController.listFeedback as any);
router.patch("/feedback/:id", FeedbackController.updateFeedback as any);

export default router;

// src/routes/notificationTest.routes.ts
//
// Admin-only. See notificationTest.controller.ts for the reasoning —
// every send here is scoped to one explicit account, defaulting to the
// calling admin's own.

import { Router } from "express";

import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import * as NotificationTestController from "../controllers/notificationTest.controller";

const router = Router();
router.use(authenticateUser, requireAdmin);

router.post(
  "/notifications/test-send",
  standardLimiter,
  NotificationTestController.testSendNotification as any,
);

export default router;

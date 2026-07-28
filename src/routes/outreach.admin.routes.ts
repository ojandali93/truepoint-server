// src/routes/outreach.admin.routes.ts
//
// Admin-only influencer outreach CRM. Deliberately NOT behind a feature
// flag — this is permanently for admin use only, same gate as
// /admin/affiliates, /admin/users, etc.

import { Router } from "express";

import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import * as OutreachController from "../controllers/outreach.controller";

const router = Router();
router.use(authenticateUser, requireAdmin);

router.get(
  "/outreach/contacts",
  standardLimiter,
  OutreachController.listContacts as any,
);
router.post(
  "/outreach/contacts",
  standardLimiter,
  OutreachController.createContact as any,
);
router.get(
  "/outreach/contacts/:id",
  standardLimiter,
  OutreachController.getContact as any,
);
router.patch(
  "/outreach/contacts/:id",
  standardLimiter,
  OutreachController.updateContact as any,
);
router.delete(
  "/outreach/contacts/:id",
  standardLimiter,
  OutreachController.deleteContact as any,
);

router.post(
  "/outreach/contacts/:id/interactions",
  standardLimiter,
  OutreachController.logInteraction as any,
);
router.delete(
  "/outreach/interactions/:id",
  standardLimiter,
  OutreachController.deleteInteraction as any,
);

router.post(
  "/outreach/contacts/:id/convert",
  standardLimiter,
  OutreachController.convertToAffiliate as any,
);

export default router;

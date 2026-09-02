// affiliate.admin.routes.ts
//
// ADMIN affiliate CRUD. Mount under your admin prefix so it's gated by the SAME
// admin middleware that protects /admin/analytics/*, /admin/flags, etc.
//
// If your central admin router ALREADY applies authenticateUser + requireAdmin,
// you can delete the `router.use(...)` line below to avoid double-applying.

import { Router } from "express";
// TODO: adjust import paths/names to YOUR middleware.
import { authenticateUser, requireAdmin } from "../middleware/auth.middleware";
import {
  adminApproveAffiliate,
  adminCreateAffiliate,
  adminDeleteAffiliate,
  adminListAffiliates,
  adminRejectAffiliate,
  adminResendAffiliateInvite,
  adminUpdateAffiliate,
} from "../controllers/affiliate.controller";
// Phase 2 of AUDITS/affiliate-system-plan.md — commission summary + mark-paid.
import {
  adminGetAffiliateCommissionSummary,
  adminMarkAffiliatePaid,
} from "../controllers/affiliateCommissionAdmin.controller";

const router = Router();

router.use(authenticateUser, requireAdmin);

router.get("/affiliates", adminListAffiliates); // GET    /admin/affiliates
router.post("/affiliates", adminCreateAffiliate); // POST   /admin/affiliates
router.post("/affiliates/:id/invite", adminResendAffiliateInvite); // POST /admin/affiliates/:id/invite
router.post("/affiliates/:id/approve", adminApproveAffiliate); // POST /admin/affiliates/:id/approve
router.post("/affiliates/:id/reject", adminRejectAffiliate); // POST /admin/affiliates/:id/reject
router.patch("/affiliates/:id", adminUpdateAffiliate); // PATCH  /admin/affiliates/:id
router.delete("/affiliates/:id", adminDeleteAffiliate); // DELETE /admin/affiliates/:id
// `as any`: matches this codebase's established pattern (see admin.routes.ts's
// uploadSetLogo/listSetsNeedingLogo) for a controller typed directly against
// AuthenticatedRequest rather than Express's base Request.
router.get("/affiliates/:id/commission-summary", adminGetAffiliateCommissionSummary as any); // GET  /admin/affiliates/:id/commission-summary
router.post("/affiliates/:id/mark-paid", adminMarkAffiliatePaid as any); // POST /admin/affiliates/:id/mark-paid

export default router;

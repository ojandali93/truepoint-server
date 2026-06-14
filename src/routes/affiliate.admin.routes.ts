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

const router = Router();

router.use(authenticateUser, requireAdmin);

router.get("/affiliates", adminListAffiliates); // GET    /admin/affiliates
router.post("/affiliates", adminCreateAffiliate); // POST   /admin/affiliates
router.post("/affiliates/:id/invite", adminResendAffiliateInvite); // POST /admin/affiliates/:id/invite
router.post("/affiliates/:id/approve", adminApproveAffiliate); // POST /admin/affiliates/:id/approve
router.post("/affiliates/:id/reject", adminRejectAffiliate); // POST /admin/affiliates/:id/reject
router.patch("/affiliates/:id", adminUpdateAffiliate); // PATCH  /admin/affiliates/:id
router.delete("/affiliates/:id", adminDeleteAffiliate); // DELETE /admin/affiliates/:id

export default router;

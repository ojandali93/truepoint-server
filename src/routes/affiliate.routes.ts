// affiliate.routes.ts
//
// PUBLIC + authenticated-user routes.
//
// IMPORTANT — mount order: GET /affiliates must stay PUBLIC (the user isn't
// signed in yet on the signup screen). If your app applies a blanket
// `router.use(authenticateUser)` on the API prefix, this router must be mounted
// ABOVE those protected routers — exactly like your billing webhook fix in app.ts.
//
// PATCH /me/affiliation declares its own authenticateUser, so it stays protected
// regardless of mount order.

import { Router } from "express";
// TODO: adjust import path/name to your auth middleware.
import {
  claimAffiliateAccount,
  getAffiliateClaim,
  getMyAffiliate,
  listActiveAffiliates,
  setMyAffiliation,
  submitAffiliateApplication,
} from "../controllers/affiliate.controller";
import { authenticateUser } from "../middleware/auth.middleware";
import { optionalAuth } from "../middleware/optionalAuth";

const router = Router();

// Public — signup dropdown.
router.get("/affiliates", listActiveAffiliates);

// Public/member — submit a self-service affiliate application. optionalAuth:
// a valid session links the application to that account (member branch).
router.post("/affiliates/apply", optionalAuth, submitAffiliateApplication);

// Authenticated — the caller's affiliate status (gates the in-app entry).
router.get("/affiliates/me", authenticateUser, getMyAffiliate);

// Public — validate an affiliate claim code and return prefill data.
router.get("/affiliates/claim/:token", getAffiliateClaim);

// Authenticated — the just-registered user consumes their claim token:
// links the affiliate record to this account + grants the comp Pro benefit.
router.post(
  "/affiliates/claim/consume",
  authenticateUser,
  claimAffiliateAccount,
);

// Authenticated — attach chosen affiliate to the signed-in user's profile.
router.patch("/me/affiliation", authenticateUser, setMyAffiliation);

export default router;

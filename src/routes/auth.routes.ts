// src/routes/auth.routes.ts
//
// Split into two routers so there's NO ambiguity about which middleware
// applies to which route. Public router has no auth middleware at all.

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import {
  sendVerification,
  verifyEmail,
  verificationStatus,
  upsertDevice,
  logoutDevice,
  listMyDevices,
  revokeMyDevice,
} from "../controllers/auth.controller";

// ─── Public router — NO authentication ────────────────────────────────────
// The token in the request body IS the auth for verify-email.
const publicRouter = Router();
publicRouter.post("/auth/verify-email", writeLimiter, verifyEmail as any);

// ─── Authenticated router — requires Bearer token ─────────────────────────
const authedRouter = Router();
authedRouter.use(authenticateUser as any);

authedRouter.post(
  "/auth/send-verification-email",
  writeLimiter,
  sendVerification as any,
);
authedRouter.get(
  "/auth/verification-status",
  standardLimiter,
  verificationStatus as any,
);

authedRouter.post("/auth/devices", writeLimiter, upsertDevice as any);
authedRouter.post("/auth/devices/logout", writeLimiter, logoutDevice as any);
authedRouter.get("/auth/devices", standardLimiter, listMyDevices as any);
authedRouter.delete("/auth/devices/:id", writeLimiter, revokeMyDevice as any);

// ─── Combined export ──────────────────────────────────────────────────────
// Mount the public router first so its handler runs before the authed router
// gets a chance to apply its middleware.
const router = Router();
router.use(publicRouter);
router.use(authedRouter);

// ─── Combined export ──────────────────────────────────────────────────────
// Mount the public router first so its handler runs before the authed router
// gets a chance to apply its middleware.

export default router;

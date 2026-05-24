// src/routes/auth.routes.ts
//
// All auth middleware is applied PER-ROUTE, never via router.use(). This
// matters because this router is mounted at the bare "/api/v1" (alongside
// planRoutes), and "/api/v1" is a prefix of every other route including
// "/api/v1/sync/...". A router-level `router.use(authenticateUser)` would
// fire for ANY request matching the mount path — even ones this router has
// no handler for — and 401 them before they reach their real router.
// Per-route middleware only runs when the specific route matches.

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

const router = Router();

// ─── Public — the token in the body IS the auth ──────────────────────────────
router.post("/auth/verify-email", writeLimiter, verifyEmail as any);

// ─── Authenticated — authenticateUser attached PER ROUTE ─────────────────────
router.post(
  "/auth/send-verification-email",
  authenticateUser as any,
  writeLimiter,
  sendVerification as any,
);
router.get(
  "/auth/verification-status",
  authenticateUser as any,
  standardLimiter,
  verificationStatus as any,
);

router.post(
  "/auth/devices",
  authenticateUser as any,
  writeLimiter,
  upsertDevice as any,
);
router.post(
  "/auth/devices/logout",
  authenticateUser as any,
  writeLimiter,
  logoutDevice as any,
);
router.get(
  "/auth/devices",
  authenticateUser as any,
  standardLimiter,
  listMyDevices as any,
);
router.delete(
  "/auth/devices/:id",
  authenticateUser as any,
  writeLimiter,
  revokeMyDevice as any,
);

export default router;

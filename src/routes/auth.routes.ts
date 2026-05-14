// src/routes/auth.routes.ts

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

// ─── Public endpoint — token IS the auth ───────────────────────────────────
router.post("/auth/verify-email", writeLimiter, verifyEmail as any);

// ─── Authenticated endpoints ───────────────────────────────────────────────
router.use(authenticateUser as any);

router.post(
  "/auth/send-verification-email",
  writeLimiter,
  sendVerification as any,
);
router.get(
  "/auth/verification-status",
  standardLimiter,
  verificationStatus as any,
);

router.post("/auth/devices", writeLimiter, upsertDevice as any);
router.post("/auth/devices/logout", writeLimiter, logoutDevice as any);
router.get("/auth/devices", standardLimiter, listMyDevices as any);
router.delete("/auth/devices/:id", writeLimiter, revokeMyDevice as any);

export default router;

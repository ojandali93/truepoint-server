// src/controllers/auth.controller.ts

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import { supabaseAdmin } from "../lib/supabase";
import {
  sendVerificationEmail,
  verifyEmailToken,
  getVerificationStatus,
} from "../services/emailVerification.service";
import {
  registerDevice,
  deactivateDevice,
  listUserDevices,
  revokeDevice,
} from "../services/device.service";

const handle = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[AuthController]", err);
  return res.status(500).json({ error: "Something went wrong" });
};

// ─── Email verification ─────────────────────────────────────────────────────

// POST /auth/send-verification-email
// Called by the frontend after Stripe completes (or anytime user wants a resend).
export const sendVerification = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    // Look up the user's email via the auth admin API
    const { data: authData } = await supabaseAdmin.auth.admin.getUserById(
      req.user.id,
    );
    const email = authData?.user?.email;
    if (!email) {
      res.status(400).json({ error: "User email not found" });
      return;
    }

    // Cooldown check — don't let users hammer the resend button
    const status = await getVerificationStatus(req.user.id);
    if (!status.canResend) {
      res.status(429).json({
        error: "Please wait a moment before requesting another email.",
      });
      return;
    }

    const result = await sendVerificationEmail(req.user.id, email);
    res.json({ data: result });
  } catch (err) {
    handle(res, err);
  }
};

// POST /auth/verify-email — body: { token }
// Public endpoint (no auth required) — the token IS the auth.
// Called by the /verify-email page when the user clicks the link.
export const verifyEmail = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { token } = req.body;
    const result = await verifyEmailToken(token);
    if (!result.verified) {
      res.status(400).json({
        error: result.reason ?? "Verification failed",
      });
      return;
    }
    res.json({ data: { verified: true, userId: result.userId } });
  } catch (err) {
    handle(res, err);
  }
};

// GET /auth/verification-status
export const verificationStatus = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const data = await getVerificationStatus(req.user.id);
    res.json({ data });
  } catch (err) {
    handle(res, err);
  }
};

// ─── Devices ────────────────────────────────────────────────────────────────

// POST /auth/devices — register or update current device on login
export const upsertDevice = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const ipAddress =
      (req.headers["x-forwarded-for"] as string)?.split(",")[0].trim() ||
      req.socket.remoteAddress ||
      undefined;

    const record = await registerDevice(req.user.id, {
      deviceId: req.body.deviceId,
      deviceType: req.body.deviceType,
      deviceName: req.body.deviceName,
      browser: req.body.browser,
      os: req.body.os,
      pushToken: req.body.pushToken,
      pushProvider: req.body.pushProvider,
      ipAddress,
    });
    res.status(201).json({ data: record });
  } catch (err) {
    handle(res, err);
  }
};

// POST /auth/devices/logout — mark current device inactive on logout
// Body: { deviceId }
export const logoutDevice = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const { deviceId } = req.body;
    if (!deviceId) {
      res.status(400).json({ error: "deviceId is required" });
      return;
    }
    await deactivateDevice(req.user.id, deviceId);
    res.json({ data: { ok: true } });
  } catch (err) {
    handle(res, err);
  }
};

// GET /auth/devices
export const listMyDevices = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    const activeOnly = req.query.activeOnly === "true";
    const devices = await listUserDevices(req.user.id, activeOnly);
    res.json({ data: devices });
  } catch (err) {
    handle(res, err);
  }
};

// DELETE /auth/devices/:id — revoke a specific device from settings
export const revokeMyDevice = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    await revokeDevice(req.user.id, req.params.id);
    res.json({ data: { revoked: true } });
  } catch (err) {
    handle(res, err);
  }
};

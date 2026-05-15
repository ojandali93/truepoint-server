// src/services/emailVerification.service.ts
//
// Manages our own email verification flow (Supabase's "Confirm email" is OFF).
// Stores token + sent_at + verified_at on the profiles table.

import crypto from "crypto";
import { supabaseAdmin } from "../lib/supabase";
import { sendEmail } from "../lib/email";

const TOKEN_TTL_HOURS = 24;
const FRONTEND_URL = process.env.FRONTEND_URL ?? "https://truepointtcg.com";

// ─── Send (or re-send) verification email ──────────────────────────────────

export const sendVerificationEmail = async (
  userId: string,
  email: string,
): Promise<{ sent: boolean }> => {
  // Generate a fresh token. Cryptographically random, 32 bytes.
  const token = crypto.randomBytes(32).toString("hex");
  const now = new Date().toISOString();

  // Save token + timestamp to profile
  const { error: updateErr } = await supabaseAdmin
    .from("profiles")
    .update({
      email_verification_token: token,
      email_verification_sent_at: now,
    })
    .eq("id", userId);

  if (updateErr) throw updateErr;

  // Compose the verification URL — points to FRONTEND, which will POST to backend
  const verifyUrl = `${FRONTEND_URL}/verify-email?token=${encodeURIComponent(token)}`;

  const html = `
<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 560px;">
  <div style="background: #0D0E11; color: #C9A84C; padding: 18px 22px; font-size: 12px; letter-spacing: 0.08em; font-weight: 500;">
    TRUEPOINT TCG
  </div>
  <div style="padding: 32px 22px; background: #f8f8f8; border: 1px solid #e0e0e0; border-top: none;">
    <h2 style="margin: 0 0 14px; font-size: 22px; color: #0D0E11; font-weight: 500;">
      Confirm your email
    </h2>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 24px;">
      You're almost done. Click the button below to verify your email and unlock your TruePoint account.
    </p>
    <div style="margin: 0 0 28px;">
      <a href="${verifyUrl}"
         style="display: inline-block; padding: 12px 24px; background: #C9A84C; color: #0D0E11; border-radius: 8px; text-decoration: none; font-weight: 500; font-size: 14px;">
        Confirm Email →
      </a>
    </div>
    <p style="font-size: 12px; line-height: 1.6; color: #666; margin: 0 0 8px;">
      Or copy and paste this URL into your browser:
    </p>
    <p style="font-size: 11px; line-height: 1.5; color: #888; word-break: break-all; margin: 0 0 24px;">
      ${verifyUrl}
    </p>
    <p style="font-size: 12px; color: #888; margin: 0; padding-top: 16px; border-top: 1px solid #e0e0e0;">
      This link expires in 24 hours. If you didn't sign up for TruePoint, you can ignore this email.
    </p>
  </div>
</div>
  `.trim();

  const text = [
    "Confirm your TruePoint email",
    "",
    "You're almost done. Click the link below to verify your email and unlock your account:",
    "",
    verifyUrl,
    "",
    "This link expires in 24 hours.",
    "If you didn't sign up for TruePoint, you can ignore this email.",
  ].join("\n");

  const result = await sendEmail({
    to: email,
    subject: "Confirm your TruePoint email",
    html,
    text,
  });

  return { sent: result.ok };
};

// ─── Verify a token ─────────────────────────────────────────────────────────

export const verifyEmailToken = async (
  token: string,
): Promise<{ verified: boolean; userId: string | null; reason?: string }> => {
  if (!token || typeof token !== "string") {
    return { verified: false, userId: null, reason: "Invalid token" };
  }

  // Look up the profile by token (indexed)
  const { data: profile, error } = await supabaseAdmin
    .from("profiles")
    .select("id, email_verified, email_verification_sent_at")
    .eq("email_verification_token", token)
    .maybeSingle();

  if (error) throw error;
  if (!profile) {
    return { verified: false, userId: null, reason: "Token not found" };
  }

  // Already verified? Idempotent — return success.
  if (profile.email_verified) {
    return { verified: true, userId: profile.id };
  }

  // Expired?
  if (profile.email_verification_sent_at) {
    const sentAt = new Date(profile.email_verification_sent_at).getTime();
    const expiresAt = sentAt + TOKEN_TTL_HOURS * 60 * 60 * 1000;
    if (Date.now() > expiresAt) {
      return { verified: false, userId: profile.id, reason: "Token expired" };
    }
  }

  // Mark as verified, clear the token so it can't be replayed
  const now = new Date().toISOString();
  const { error: updateErr } = await supabaseAdmin
    .from("profiles")
    .update({
      email_verified: true,
      email_verified_at: now,
      email_verification_token: null,
    })
    .eq("id", profile.id);

  if (updateErr) throw updateErr;

  return { verified: true, userId: profile.id };
};

// ─── Get verification status (used by the app gate) ────────────────────────

export const getVerificationStatus = async (
  userId: string,
): Promise<{
  emailVerified: boolean;
  sentAt: string | null;
  canResend: boolean; // false during a 60s cooldown after last send
}> => {
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("email_verified, email_verification_sent_at")
    .eq("id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return { emailVerified: false, sentAt: null, canResend: true };
  }

  let canResend = true;
  if (data.email_verification_sent_at) {
    const sentAt = new Date(data.email_verification_sent_at).getTime();
    canResend = Date.now() - sentAt > 60_000; // 60s cooldown between sends
  }

  return {
    emailVerified: data.email_verified ?? false,
    sentAt: data.email_verification_sent_at,
    canResend,
  };
};

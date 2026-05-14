import crypto from "crypto";
import axios from "axios";
import { supabaseAdmin } from "./supabase";

const COOLDOWN_MS = 60_000;
const TOKEN_TTL_SEC = 48 * 60 * 60;

function verificationSecret(): string {
  const s = process.env.EMAIL_VERIFICATION_SECRET;
  if (!s?.trim()) {
    throw Object.assign(
      new Error("EMAIL_VERIFICATION_SECRET is not configured"),
      { status: 503 },
    );
  }
  return s.trim();
}

function signPayload(data: Record<string, unknown>): string {
  const payload = JSON.stringify(data);
  const sig = crypto
    .createHmac("sha256", verificationSecret())
    .update(payload)
    .digest("hex");
  return `${Buffer.from(payload, "utf8").toString("base64url")}.${sig}`;
}

function parseSignedPayload(token: string): Record<string, unknown> | null {
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  let secret: string;
  try {
    secret = verificationSecret();
  } catch {
    return null;
  }
  let payload: string;
  try {
    payload = Buffer.from(payloadB64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex");
  if (sig.length !== expectedSig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expectedSig, "hex")))
      return null;
  } catch {
    return null;
  }
  try {
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function getVerificationStatus(userId: string): Promise<{
  verified: boolean;
  canResend: boolean;
}> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    throw Object.assign(new Error("User not found"), { status: 404 });
  }
  const user = data.user;
  const verified = Boolean(user.email_confirmed_at);
  if (verified) return { verified: true, canResend: false };

  const last = user.user_metadata?.tp_email_ver_sent_at as number | undefined;
  const canResend = last == null || Date.now() - last >= COOLDOWN_MS;
  return { verified: false, canResend };
}

export async function sendVerificationEmail(
  userId: string,
  email: string,
): Promise<{ ok: true; sentAt: string }> {
  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    throw Object.assign(new Error("User not found"), { status: 404 });
  }
  const user = data.user;
  if (user.email !== email) {
    throw Object.assign(new Error("Email mismatch"), { status: 400 });
  }
  if (user.email_confirmed_at) {
    return { ok: true, sentAt: new Date().toISOString() };
  }

  const appUrl = process.env.APP_URL?.replace(/\/$/, "") ?? "";
  if (!appUrl) {
    throw Object.assign(new Error("APP_URL is not configured"), { status: 503 });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey?.trim()) {
    throw Object.assign(
      new Error("RESEND_API_KEY is not configured"),
      { status: 503 },
    );
  }

  verificationSecret();

  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL_SEC;
  const token = signPayload({ userId, email, exp });
  const verifyUrl = `${appUrl}/verify-email?token=${encodeURIComponent(token)}`;
  const from =
    process.env.RESEND_FROM_EMAIL ?? "TruePoint <onboarding@resend.dev>";

  await axios.post(
    "https://api.resend.com/emails",
    {
      from,
      to: email,
      subject: "Verify your TruePoint email",
      html: `<p>Confirm your email address:</p><p><a href="${verifyUrl}">Verify email</a></p><p>This link expires in 48 hours.</p>`,
    },
    {
      headers: {
        Authorization: `Bearer ${resendKey.trim()}`,
        "Content-Type": "application/json",
      },
    },
  );

  const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    user_metadata: {
      ...user.user_metadata,
      tp_email_ver_sent_at: Date.now(),
    },
  });
  if (upErr) throw upErr;

  return { ok: true, sentAt: new Date().toISOString() };
}

export async function verifyEmailToken(token: string): Promise<{
  verified: boolean;
  userId?: string;
  reason?: string;
}> {
  if (!token || typeof token !== "string") {
    return { verified: false, reason: "Missing token" };
  }

  const parsed = parseSignedPayload(token);
  if (!parsed) {
    return { verified: false, reason: "Invalid or expired link" };
  }

  const userId = parsed.userId as string | undefined;
  const email = parsed.email as string | undefined;
  const exp = parsed.exp as number | undefined;
  if (!userId || !email || typeof exp !== "number") {
    return { verified: false, reason: "Invalid token payload" };
  }
  if (Math.floor(Date.now() / 1000) > exp) {
    return { verified: false, reason: "Link has expired" };
  }

  const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
  if (error || !data?.user) {
    return { verified: false, reason: "User not found" };
  }
  if (data.user.email !== email) {
    return { verified: false, reason: "Email mismatch" };
  }
  if (data.user.email_confirmed_at) {
    return { verified: true, userId };
  }

  const { error: upErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
    email_confirm: true,
  });
  if (upErr) {
    return { verified: false, reason: upErr.message };
  }
  return { verified: true, userId };
}

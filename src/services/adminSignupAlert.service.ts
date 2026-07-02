// src/services/adminSignupAlert.service.ts
//
// Sends a push ONLY to admin devices whenever a new user completes signup,
// including their name, tier, and how they signed up. This is separate from
// the (disabled) user-facing digests and from admin broadcast — it's an
// internal founder alert.
//
// Targeting: set ADMIN_ALERT_USER_IDS (comma-separated auth user IDs — your
// own user id). The push goes to that user's registered devices, so you get
// it on any device where you're logged into the app with notifications on.
// If the env var is empty, this is a no-op (safe).
//
// Fires exactly once per user via the profiles.admin_signup_alerted_at guard,
// so the idempotent createProfile path can't double-alert.

import { supabaseAdmin } from "../lib/supabase";
import { sendPushToUsers } from "./push.service";

function adminAlertUserIds(): string[] {
  return (process.env.ADMIN_ALERT_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function notifyAdminsOfSignup(userId: string): Promise<void> {
  const admins = adminAlertUserIds();
  if (admins.length === 0) return; // not configured → do nothing

  // Profile: name + one-time guard. (signup_platform is optional — only set if
  // a client passes it at signup; null otherwise.)
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("full_name, signup_platform, admin_signup_alerted_at")
    .eq("id", userId)
    .maybeSingle();

  if (!profile) return;
  if (profile.admin_signup_alerted_at) return; // already alerted — exactly once

  // Tier + platform, if they already have a subscription row (e.g. started a
  // trial during onboarding). At plain signup there's no row → treated as free.
  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("plan, platform, status")
    .eq("user_id", userId)
    .maybeSingle();

  // Signup provider from auth (apple / google / email) — flags Apple sign-ups
  // without any client change.
  let provider = "email";
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    provider =
      (data?.user?.app_metadata?.provider as string) ??
      data?.user?.identities?.[0]?.provider ??
      "email";
  } catch {
    /* non-fatal — fall back to "email" */
  }

  const name = (profile.full_name ?? "").trim() || "New user";
  const tier = sub?.plan ?? "starter (free)";

  // Prefer the most precise surface available:
  //   1. subscription platform (apple/google/web) if they've subscribed
  //   2. client-recorded signup_platform (ios/android/web) if present
  //   3. auth provider (Apple is exact; google/email are best-effort)
  const surface =
    sub?.platform ??
    profile.signup_platform ??
    (provider === "apple"
      ? "Apple"
      : provider === "google"
        ? "Google"
        : "web / email");

  await sendPushToUsers(admins, {
    title: "New sign-up 🎉",
    body: `${name} · ${tier} · via ${surface}`,
    data: { type: "admin_signup", userId },
  });

  await supabaseAdmin
    .from("profiles")
    .update({ admin_signup_alerted_at: new Date().toISOString() })
    .eq("id", userId);
}

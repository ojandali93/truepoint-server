import { insertFeedback } from "../repositories/feedback.repository";
import { sendEmail } from "../lib/email";
import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

interface SubmitFeedbackArgs {
  category: string;
  message: string;
  app_version?: string;
  platform?: string;
  contact_email?: string;
}

export const submitFeedback = async (
  userId: string,
  args: SubmitFeedbackArgs,
) => {
  const feedback = await insertFeedback({
    userId,
    category: args.category,
    message: args.message,
    appVersion: args.app_version,
    platform: args.platform,
    contactEmail: args.contact_email,
  });

  // Notify support — best-effort. Never let an email hiccup fail the user's
  // submission; the row is already saved and visible in the admin panel.
  void notifySupport(userId, args).catch(() => {});

  return feedback;
};

async function notifySupport(userId: string, args: SubmitFeedbackArgs) {
  const to = process.env.SUPPORT_EMAIL?.trim();
  if (!to) return; // no recipient configured — skip silently

  let accountEmail = "unknown";
  try {
    const { data } = await supabaseAdmin.auth.admin.getUserById(userId);
    accountEmail = data?.user?.email ?? "unknown";
  } catch {
    // ignore — we'll send without it
  }

  const replyTo =
    args.contact_email ||
    (accountEmail !== "unknown" ? accountEmail : undefined);
  const platform = args.platform ?? "unknown";
  const version = args.app_version ?? "unknown";
  const isSupport = args.category === "support";

  const safe = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const subject = `[TruePoint ${isSupport ? "SUPPORT" : args.category}] ${replyTo ?? accountEmail}`;

  const html = `
    <h2>New ${safe(args.category)} ${isSupport ? "request" : "feedback"}</h2>
    <p><strong>Account:</strong> ${safe(accountEmail)} (user ${userId})</p>
    ${args.contact_email ? `<p><strong>Contact email:</strong> ${safe(args.contact_email)}</p>` : ""}
    <p><strong>Platform:</strong> ${safe(platform)} &middot; <strong>Version:</strong> ${safe(version)}</p>
    <hr/>
    <p style="white-space:pre-wrap">${safe(args.message)}</p>
  `;
  const text = `New ${args.category} ${isSupport ? "request" : "feedback"}
Account: ${accountEmail} (user ${userId})${args.contact_email ? `\nContact email: ${args.contact_email}` : ""}
Platform: ${platform} | Version: ${version}

${args.message}`;

  try {
    await sendEmail({ to, subject, html, text, replyTo });
  } catch (err: any) {
    await logError({
      source: "feedback-email",
      message: err?.message ?? "Failed to email support",
      error: err,
      userId,
    });
  }
}

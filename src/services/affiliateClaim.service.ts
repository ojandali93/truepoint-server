// affiliateClaim.service.ts
//
// Single-use, expiring claim tokens that let an affiliate (created by an admin)
// register their own user account, link it to their affiliate record, and
// receive their partner perk. Plus the Resend invite email.
//
// All access is service-role (supabaseAdmin) — these rows are sensitive
// (a valid token grants the ability to claim an affiliate identity), and the
// table is RLS-locked to service-role only.

import { supabaseAdmin } from "../lib";
import { sendEmail } from "../lib/email";

const CLAIM_TABLE = "affiliate_claim_tokens";
const AFFILIATE_TABLE = "affiliates";

export interface IssuedToken {
  token: string;
  expires_at: string;
}

// Fields safe to prefill on the claim/registration screen.
export interface ClaimPrefill {
  affiliate_id: string;
  name: string;
  slug: string | null;
  type: string;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  instagram: string | null;
  website: string | null;
}

function appUrl(): string {
  const url = process.env.APP_URL?.replace(/\/$/, "");
  if (!url) {
    throw Object.assign(new Error("APP_URL is not configured"), {
      status: 503,
    });
  }
  return url;
}

/** The link an affiliate clicks to claim their account. */
export function claimUrl(token: string): string {
  return `${appUrl()}/affiliate/claim?token=${encodeURIComponent(token)}`;
}

/**
 * Issue a fresh claim token for an affiliate. Rotates: any existing UNCLAIMED
 * token for this affiliate is removed first, so there is at most one open
 * invite at a time (also satisfies the partial unique index). Already-claimed
 * tokens are preserved as an audit trail.
 */
export async function issueClaimToken(
  affiliateId: string,
): Promise<IssuedToken> {
  const { error: delErr } = await supabaseAdmin
    .from(CLAIM_TABLE)
    .delete()
    .eq("affiliate_id", affiliateId)
    .is("claimed_at", null);
  if (delErr) throw delErr;

  // token + expires_at come from DB defaults (gen_random_uuid(), now()+30d).
  const { data, error } = await supabaseAdmin
    .from(CLAIM_TABLE)
    .insert({ affiliate_id: affiliateId })
    .select("token, expires_at")
    .single();
  if (error) throw error;
  return data as IssuedToken;
}

/**
 * Validate a token (read-only — does NOT consume it) and return the affiliate
 * fields used to prefill the registration screen. Throws a status-tagged error
 * if the token is unknown, already used, or expired.
 */
export async function getAffiliateForClaim(
  token: string,
): Promise<ClaimPrefill> {
  if (!token || typeof token !== "string") {
    throw Object.assign(new Error("A claim code is required"), { status: 400 });
  }

  const { data: t, error } = await supabaseAdmin
    .from(CLAIM_TABLE)
    .select("affiliate_id, expires_at, claimed_at")
    .eq("token", token)
    .single();
  if (error || !t) {
    throw Object.assign(new Error("Invalid claim code"), { status: 404 });
  }
  if (t.claimed_at) {
    throw Object.assign(new Error("This claim code has already been used"), {
      status: 409,
    });
  }
  if (new Date(t.expires_at).getTime() < Date.now()) {
    throw Object.assign(new Error("This claim code has expired"), {
      status: 410,
    });
  }

  const { data: aff, error: aErr } = await supabaseAdmin
    .from(AFFILIATE_TABLE)
    .select(
      "id, name, slug, type, contact_name, contact_email, contact_phone, instagram, website",
    )
    .eq("id", t.affiliate_id)
    .single();
  if (aErr || !aff) {
    throw Object.assign(new Error("Affiliate not found"), { status: 404 });
  }

  return {
    affiliate_id: aff.id,
    name: aff.name,
    slug: aff.slug ?? null,
    type: aff.type,
    contact_name: aff.contact_name ?? null,
    contact_email: aff.contact_email ?? null,
    contact_phone: aff.contact_phone ?? null,
    instagram: aff.instagram ?? null,
    website: aff.website ?? null,
  };
}

// ── Invite email ──────────────────────────────────────────────────────────────

interface AffiliateLike {
  name: string;
  slug?: string | null;
  contact_email?: string | null;
}

function buildInviteEmail(affiliate: AffiliateLike, token: string) {
  const url = claimUrl(token);
  const code = token;
  const referral = affiliate.slug
    ? affiliate.slug
    : "(your referral code will be shown in your dashboard)";

  const subject = "You're invited to the TruePoint TCG Affiliate Program";

  const html = `
  <div style="background:#0D0E11;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:520px;margin:0 auto;background:#16171B;border:1px solid #2A2C31;border-radius:14px;overflow:hidden;">
      <div style="padding:28px 32px;border-bottom:1px solid #2A2C31;">
        <div style="color:#C9A961;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;">TruePoint TCG</div>
        <div style="color:#F4F4F5;font-size:20px;font-weight:600;margin-top:6px;">Affiliate Program Invitation</div>
      </div>
      <div style="padding:28px 32px;color:#C7C9CE;font-size:15px;line-height:1.6;">
        <p style="margin:0 0 16px;">Hi ${affiliate.name},</p>
        <p style="margin:0 0 16px;">
          You've been set up as a TruePoint TCG affiliate partner. Create your
          partner account to access your dashboard, see signups attributed to
          your code, and activate your partner subscription benefit.
        </p>

        <div style="background:#0F1013;border:1px solid #2A2C31;border-radius:10px;padding:16px 18px;margin:0 0 20px;">
          <div style="color:#8A8D94;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Your referral code (give this to customers)</div>
          <div style="color:#C9A961;font-size:18px;font-weight:600;font-family:'DM Mono',ui-monospace,monospace;">${referral}</div>
        </div>

        <p style="margin:0 0 18px;">Tap the button below to create your account:</p>
        <div style="text-align:center;margin:0 0 22px;">
          <a href="${url}"
             style="display:inline-block;background:#C9A961;color:#0D0E11;text-decoration:none;font-weight:600;font-size:15px;padding:13px 28px;border-radius:9px;">
            Create my affiliate account
          </a>
        </div>

        <div style="background:#0F1013;border:1px solid #2A2C31;border-radius:10px;padding:14px 18px;margin:0 0 18px;">
          <div style="color:#8A8D94;font-size:11px;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:6px;">Or enter this claim code manually</div>
          <div style="color:#F4F4F5;font-size:13px;font-family:'DM Mono',ui-monospace,monospace;word-break:break-all;">${code}</div>
        </div>

        <p style="margin:0 0 4px;color:#8A8D94;font-size:13px;">
          This claim code can be used once and expires in 30 days. If it expires,
          reply to this email and we'll send a new one.
        </p>
      </div>
      <div style="padding:18px 32px;border-top:1px solid #2A2C31;color:#6B6E76;font-size:12px;">
        TruePoint TCG · If you weren't expecting this, you can ignore this email.
      </div>
    </div>
  </div>`;

  const text = [
    `Hi ${affiliate.name},`,
    ``,
    `You've been set up as a TruePoint TCG affiliate partner.`,
    ``,
    `Your referral code (give this to customers): ${referral}`,
    ``,
    `Create your affiliate account: ${url}`,
    `Or enter this claim code manually: ${code}`,
    ``,
    `This claim code can be used once and expires in 30 days.`,
    `If it expires, reply to this email and we'll send a new one.`,
    ``,
    `TruePoint TCG`,
  ].join("\n");

  return { subject, html, text };
}

/**
 * Send the invite email for an affiliate. Caller is responsible for having a
 * contact_email; throws if missing. Best-effort at the call site — a failed
 * email should not roll back affiliate creation (admin can resend).
 */
export async function sendAffiliateInvite(
  affiliate: AffiliateLike,
  token: string,
): Promise<void> {
  const to = affiliate.contact_email?.trim();
  if (!to) {
    throw Object.assign(new Error("Affiliate has no contact email"), {
      status: 400,
    });
  }
  const { subject, html, text } = buildInviteEmail(affiliate, token);
  await sendEmail({ to, subject, html, text });
}

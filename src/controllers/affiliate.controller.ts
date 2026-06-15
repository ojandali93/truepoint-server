// affiliate.controller.ts
import type { Request, Response } from "express";
import { supabaseAdmin } from "../lib";
import {
  applyAffiliate,
  approveAffiliate,
  countSignupsForAffiliate,
  create,
  getAffiliateByUserId,
  getById,
  listActive,
  listAllWithCounts,
  rejectAffiliate,
  remove,
  setAffiliateActive,
  setUserAffiliation,
  update,
} from "../services/affiliate.service";
import {
  claimUrl,
  consumeClaimToken,
  getAffiliateForClaim,
  grantCompPro,
  issueClaimToken,
  sendAffiliateInvite,
  sendApprovedEmail,
} from "../services/affiliateClaim.service";

// ── Public ───────────────────────────────────────────────────────────────────

// GET /affiliates  — active affiliates for the signup dropdown (no auth).
export async function listActiveAffiliates(_req: Request, res: Response) {
  try {
    const data = await listActive();
    res.json({ data });
  } catch (err) {
    res
      .status(500)
      .json({ error: errMessage(err, "Failed to load affiliates") });
  }
}

// GET /affiliates/claim/:token  — validate a claim code (no auth) and return
// the affiliate fields used to prefill the registration screen. Read-only:
// does NOT consume the token.
export async function getAffiliateClaim(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { token } = req.params;
    const data = await getAffiliateForClaim(token);
    res.json({ data });
  } catch (err) {
    const status = errStatus(err, 400);
    res.status(status).json({ error: errMessage(err, "Invalid claim code") });
  }
}

// ── Authenticated user ───────────────────────────────────────────────────────

// PATCH /me/affiliation  — attach the chosen affiliate to the signed-in user.
export async function setMyAffiliation(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    // TODO: match how YOUR authenticateUser middleware exposes the user id.
    // Common shapes: req.user.id  |  req.userId  |  res.locals.user.id
    const userId =
      (req as unknown as { user?: { id?: string }; userId?: string }).user
        ?.id ?? (req as unknown as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const affiliateId = (req.body ?? {}).affiliate_id;
    if (!affiliateId || typeof affiliateId !== "string") {
      res.status(400).json({ error: "affiliate_id is required" });
      return;
    }

    const data = await setUserAffiliation(userId, affiliateId);
    res.json({ data });
  } catch (err) {
    res
      .status(400)
      .json({ error: errMessage(err, "Failed to set affiliation") });
  }
}

// POST /affiliates/claim/consume — the signed-in (just-registered) user claims
// their affiliate record: burns the single-use token, links the affiliate to
// this account, activates it, and grants the comp Pro benefit.
export async function claimAffiliateAccount(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId =
      (req as unknown as { user?: { id?: string }; userId?: string }).user
        ?.id ?? (req as unknown as { userId?: string }).userId;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }

    const token = (req.body ?? {}).token;
    if (!token || typeof token !== "string") {
      res.status(400).json({ error: "token is required" });
      return;
    }

    const data = await consumeClaimToken(userId, token);
    res.json({ data });
  } catch (err) {
    res
      .status(errStatus(err, 400))
      .json({ error: errMessage(err, "Failed to claim affiliate account") });
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────

// GET /admin/affiliates  — all affiliates + signup_count.
export async function adminListAffiliates(
  _req: Request,
  res: Response,
): Promise<void> {
  try {
    const data = await listAllWithCounts();
    res.json({ data });
  } catch (err) {
    res
      .status(500)
      .json({ error: errMessage(err, "Failed to load affiliates") });
  }
}

// POST /admin/affiliates
export async function adminCreateAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const body = req.body ?? {};
    if (
      !body.name ||
      typeof body.name !== "string" ||
      body.name.trim().length < 2
    ) {
      res.status(400).json({ error: "name is required (min 2 characters)" });
      return;
    }
    const data = await create(body);

    // Issue a single-use claim token so this affiliate can register their own
    // account, and email it to their contact address if we have one. Email is
    // best-effort: a send failure must not fail affiliate creation (the admin
    // can resend, and the token is returned below for manual delivery).
    const invite: {
      emailed: boolean;
      email_error?: string;
      claim_url: string;
      token: string;
      expires_at: string;
    } = {
      emailed: false,
      claim_url: "",
      token: "",
      expires_at: "",
    };
    try {
      const issued = await issueClaimToken(data.id);
      invite.token = issued.token;
      invite.expires_at = issued.expires_at;
      invite.claim_url = claimUrl(issued.token);
      if (data.contact_email) {
        try {
          await sendAffiliateInvite(data, issued.token);
          invite.emailed = true;
        } catch (mailErr) {
          invite.email_error = errMessage(
            mailErr,
            "Failed to send invite email",
          );
        }
      }
    } catch (tokenErr) {
      invite.email_error = errMessage(tokenErr, "Failed to issue claim token");
    }

    res.status(201).json({ data, invite });
  } catch (err) {
    // e.g. duplicate slug → surface a clean message
    res
      .status(400)
      .json({ error: errMessage(err, "Failed to create affiliate") });
  }
}

// POST /admin/affiliates/:id/invite — (re)issue + (re)send the claim invite.
export async function adminResendAffiliateInvite(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const affiliate = await getById(id);
    const issued = await issueClaimToken(id);

    let emailed = false;
    let email_error: string | undefined;
    if (affiliate.contact_email) {
      try {
        await sendAffiliateInvite(affiliate, issued.token);
        emailed = true;
      } catch (mailErr) {
        email_error = errMessage(mailErr, "Failed to send invite email");
      }
    } else {
      email_error = "Affiliate has no contact email";
    }

    res.json({
      data: {
        id,
        emailed,
        email_error,
        claim_url: claimUrl(issued.token),
        token: issued.token,
        expires_at: issued.expires_at,
      },
    });
  } catch (err) {
    res.status(400).json({ error: errMessage(err, "Failed to resend invite") });
  }
}

// PATCH /admin/affiliates/:id
export async function adminUpdateAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const data = await update(id, req.body ?? {});
    res.json({ data });
  } catch (err) {
    res
      .status(400)
      .json({ error: errMessage(err, "Failed to update affiliate") });
  }
}

// DELETE /admin/affiliates/:id
export async function adminDeleteAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    await remove(id);
    res.json({ data: { id, deleted: true } });
  } catch (err) {
    res
      .status(400)
      .json({ error: errMessage(err, "Failed to delete affiliate") });
  }
}

// ── Self-service applications (Phase 1) ──────────────────────────────────────

const SOCIAL_KEYS = [
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "facebook",
  "twitch",
  "website",
] as const;

// Keep only known platforms with non-empty string handles; cap length. Prevents
// arbitrary/huge jsonb payloads from the public endpoint.
function cleanSocials(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of SOCIAL_KEYS) {
      const v = (raw as Record<string, unknown>)[k];
      if (typeof v === "string" && v.trim()) out[k] = v.trim().slice(0, 200);
    }
  }
  return out;
}

function isEmail(s: unknown): s is string {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());
}

// POST /affiliates/apply — create a pending application. optionalAuth: a valid
// session means the member branch (account linked, email trusted from session).
export async function submitAffiliateApplication(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const u = (req as unknown as { user?: { id?: string; email?: string } })
      .user;
    const body = (req.body ?? {}) as Record<string, unknown>;

    // Honeypot — bots fill hidden fields; humans leave them empty. Pretend success.
    if (typeof body.hp_field === "string" && body.hp_field.trim()) {
      res.status(201).json({ data: { status: "pending" } });
      return;
    }

    const personName = typeof body.name === "string" ? body.name.trim() : "";
    const businessName =
      typeof body.business_name === "string" ? body.business_name.trim() : "";
    if (!personName && !businessName) {
      res.status(400).json({ error: "Your name is required" });
      return;
    }

    const phone =
      typeof body.phone === "string" ? body.phone.trim() || null : null;
    const requested_slug =
      typeof body.requested_slug === "string" ? body.requested_slug : null;
    const socials = cleanSocials(body.socials);

    let userId: string | null = null;
    let contactEmail: string | null = null;

    if (u?.id) {
      // Member branch: trust the session for identity. Ignore any form email.
      userId = u.id;
      contactEmail = u.email ?? null;
      // Block a second affiliate for the same account (also DB-guarded).
      const existing = await getAffiliateByUserId(userId);
      if (existing) {
        res.status(409).json({
          error:
            existing.status === "pending"
              ? "You already have an affiliate application pending."
              : "You're already part of the affiliate program.",
        });
        return;
      }
    } else {
      // Guest branch: require a valid email, and block emails that already
      // have an account (those users must apply from inside the app).
      if (!isEmail(body.email)) {
        res.status(400).json({ error: "A valid email is required" });
        return;
      }
      contactEmail = (body.email as string).trim();
      const { data: exists, error: rpcErr } = await supabaseAdmin.rpc(
        "email_has_account",
        { p_email: contactEmail },
      );
      if (rpcErr) throw rpcErr;
      if (exists === true) {
        res.status(409).json({
          error:
            "An account already exists for this email. Please log in and apply from the app.",
        });
        return;
      }
    }

    const data = await applyAffiliate(
      {
        name: businessName || null,
        contact_name: personName || null,
        contact_email: contactEmail,
        contact_phone: phone,
        requested_slug,
        socials,
      },
      userId,
    );

    res.status(201).json({ data: { status: "pending", id: data.id } });
  } catch (err) {
    // Map the DB prevention guards to friendly messages.
    const code = (err as { code?: string }).code;
    const msg = errMessage(err, "");
    if (code === "23505") {
      if (msg.includes("one_open_application")) {
        res.status(409).json({
          error: "You already have an affiliate application pending.",
        });
        return;
      }
      if (msg.includes("one_per_user")) {
        res
          .status(409)
          .json({ error: "You're already part of the affiliate program." });
        return;
      }
    }
    res
      .status(errStatus(err, 400))
      .json({ error: errMessage(err, "Failed to submit application") });
  }
}

// POST /admin/affiliates/:id/approve — confirm/override slug, then branch:
// member (has account) → activate + grant comp Pro + approved email;
// guest (no account) → issue claim token + invite email.
export async function adminApproveAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const slug = typeof body.slug === "string" ? body.slug : "";
    const collector_rate =
      typeof body.collector_rate === "number" ? body.collector_rate : undefined;
    const pro_rate =
      typeof body.pro_rate === "number" ? body.pro_rate : undefined;

    const affiliate = await approveAffiliate(id, {
      slug,
      collector_rate,
      pro_rate,
    });

    if (affiliate.user_id) {
      // Member branch — upgrade their existing account.
      const linked = await setAffiliateActive(id);
      await grantCompPro(affiliate.user_id);
      let emailed = false;
      let email_error: string | undefined;
      try {
        await sendApprovedEmail(linked);
        emailed = true;
      } catch (mailErr) {
        email_error = errMessage(mailErr, "Failed to send approved email");
      }
      res.json({ data: linked, granted: true, emailed, email_error });
      return;
    }

    // Guest branch — issue a claim token + invite email.
    const issued = await issueClaimToken(id);
    let emailed = false;
    let email_error: string | undefined;
    if (affiliate.contact_email) {
      try {
        await sendAffiliateInvite(affiliate, issued.token);
        emailed = true;
      } catch (mailErr) {
        email_error = errMessage(mailErr, "Failed to send invite email");
      }
    } else {
      email_error = "Affiliate has no contact email";
    }
    res.json({
      data: affiliate,
      invite: {
        emailed,
        email_error,
        claim_url: claimUrl(issued.token),
        token: issued.token,
        expires_at: issued.expires_at,
      },
    });
  } catch (err) {
    res
      .status(errStatus(err, 400))
      .json({ error: errMessage(err, "Failed to approve affiliate") });
  }
}

// POST /admin/affiliates/:id/reject
export async function adminRejectAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: "id is required" });
      return;
    }
    const reason =
      typeof (req.body ?? {}).reason === "string"
        ? (req.body as { reason: string }).reason
        : undefined;
    const data = await rejectAffiliate(id, reason);
    res.json({ data });
  } catch (err) {
    res
      .status(errStatus(err, 400))
      .json({ error: errMessage(err, "Failed to reject affiliate") });
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === "string") return m;
  }
  return fallback;
}

function errStatus(err: unknown, fallback: number): number {
  if (typeof err === "object" && err && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return fallback;
}

export async function getMyAffiliate(
  req: Request,
  res: Response,
): Promise<void> {
  try {
    const userId = (req as unknown as { user?: { id?: string } }).user?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const aff = await getAffiliateByUserId(userId);
    if (!aff) {
      res.json({ data: null });
      return;
    }

    // Only meaningful once they're a live affiliate, but cheap to always compute.
    let signup_count = 0;
    try {
      signup_count = await countSignupsForAffiliate(aff.id);
    } catch {
      // Non-fatal: a count failure shouldn't blank out the whole dashboard.
      signup_count = 0;
    }

    res.json({
      data: {
        id: aff.id,
        name: aff.name ?? null,
        type: aff.type ?? null,
        status: aff.status ?? null,
        active: aff.active ?? false,
        slug: aff.slug ?? null,
        requested_slug: aff.requested_slug ?? null,
        approved_at: aff.approved_at ?? null,
        collector_rate: aff.collector_rate ?? null,
        pro_rate: aff.pro_rate ?? null,
        signup_count,
      },
    });
  } catch (err) {
    res
      .status(500)
      .json({ error: errMessage(err, "Failed to load affiliate status") });
  }
}

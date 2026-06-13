// affiliate.controller.ts
import type { Request, Response } from "express";
import {
  create,
  getById,
  listActive,
  listAllWithCounts,
  remove,
  setUserAffiliation,
  update,
} from "../services/affiliate.service";
import {
  claimUrl,
  consumeClaimToken,
  getAffiliateForClaim,
  issueClaimToken,
  sendAffiliateInvite,
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

// attribution.controller.ts
//
// AUDITS/affiliate-system-plan.md §2.3 / AUDITS/referral-program-plan.md
// §2.2 — the shared resolver's HTTP surface. Every route here is
// authenticated (a code can only ever be resolved against a real userId —
// there's no anonymous-user attribution path, by design).

import type { Response } from "express";
import type { AuthenticatedRequest } from "../types/user.types";
import { resolveAttribution } from "../services/attribution.service";
import {
  getOrCreateReferralCode,
  getReferralSummary,
} from "../services/referralReward.service";

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

function errStatus(err: unknown, fallback: number): number {
  if (typeof err === "object" && err && "status" in err) {
    const s = (err as { status?: unknown }).status;
    if (typeof s === "number") return s;
  }
  return fallback;
}

// POST /me/attribution — called right after signup (email or OAuth) with
// whatever code the user entered/the ?ref= cookie carried, AND callable
// again later within the grace period (affiliate doc §2.3) as long as no
// attribution row exists yet. One endpoint serves both call sites.
export async function submitMyAttribution(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const body = req.body ?? {};
    const rawCode = typeof body.code === "string" ? body.code : null;
    const source =
      typeof body.source === "string" &&
      ["web_cookie", "web_manual", "mobile_manual", "post_signup_grace"].includes(body.source)
        ? body.source
        : "post_signup_grace";

    const result = await resolveAttribution({
      userId,
      rawCode,
      source,
      role: req.user?.role ?? null,
    });
    res.json({ data: result });
  } catch (err) {
    res
      .status(errStatus(err, 500))
      .json({ error: errMessage(err, "Failed to resolve attribution") });
  }
}

// GET /me/referral-code — lazy-generated, idempotent.
export async function getMyReferralCode(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const code = await getOrCreateReferralCode(userId);
    res.json({ data: { code } });
  } catch (err) {
    res
      .status(errStatus(err, 500))
      .json({ error: errMessage(err, "Failed to get referral code") });
  }
}

// GET /me/referral-summary — mobile "Refer a friend" screen's one call.
export async function getMyReferralSummary(
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> {
  try {
    const userId = req.user?.id;
    if (!userId) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    const summary = await getReferralSummary(userId);
    res.json({ data: summary });
  } catch (err) {
    res
      .status(errStatus(err, 500))
      .json({ error: errMessage(err, "Failed to load referral summary") });
  }
}

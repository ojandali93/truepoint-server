// affiliate.controller.ts
import type { Request, Response } from "express";
import {
  create,
  listActive,
  listAllWithCounts,
  remove,
  setUserAffiliation,
  update,
} from "../services/affiliate.service";

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
    res.status(201).json({ data });
  } catch (err) {
    // e.g. duplicate slug → surface a clean message
    res
      .status(400)
      .json({ error: errMessage(err, "Failed to create affiliate") });
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

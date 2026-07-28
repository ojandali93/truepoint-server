// src/controllers/outreach.controller.ts

import { Request, Response } from "express";

import { logError } from "../lib/Logger";
import * as OutreachService from "../services/outreach.service";

// Status-aware error handler — same convention as regradeTracker.controller.ts.
const handle = (res: Response, err: unknown, source: string) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    res.status(e.status).json({ error: e.message ?? "Error" });
    return;
  }
  const message = err instanceof Error ? err.message : "Unexpected error";
  void logError({ source, message, error: err, userId: null });
  res.status(500).json({ error: message });
};

// GET /admin/outreach/contacts?includeArchived=true
export const listContacts = async (req: Request, res: Response) => {
  try {
    const includeArchived = req.query.includeArchived === "true";
    const contacts = await OutreachService.listContacts({ includeArchived });
    res.json({ data: contacts });
  } catch (err) {
    handle(res, err, "outreach-list-contacts");
  }
};

// GET /admin/outreach/contacts/:id
export const getContact = async (req: Request, res: Response) => {
  try {
    const result = await OutreachService.getContact(req.params.id);
    res.json({ data: result });
  } catch (err) {
    handle(res, err, "outreach-get-contact");
  }
};

// POST /admin/outreach/contacts
export const createContact = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const created = await OutreachService.createContact({
      name: body.name,
      handle: body.handle ?? null,
      primaryPlatform: body.primaryPlatform ?? null,
      socials: body.socials ?? null,
      followerCount:
        body.followerCount !== undefined && body.followerCount !== null
          ? Number(body.followerCount)
          : null,
      niche: body.niche ?? null,
      stage: body.stage,
      nextFollowUpAt: body.nextFollowUpAt ?? null,
      notes: body.notes ?? null,
    });
    res.status(201).json({ data: created });
  } catch (err) {
    handle(res, err, "outreach-create-contact");
  }
};

// PATCH /admin/outreach/contacts/:id
export const updateContact = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const patch: Record<string, unknown> = {};
    for (const key of [
      "name",
      "handle",
      "primaryPlatform",
      "socials",
      "followerCount",
      "niche",
      "stage",
      "nextFollowUpAt",
      "notes",
      "archived",
    ]) {
      if (body[key] !== undefined) patch[key] = body[key];
    }
    await OutreachService.updateContact(req.params.id, patch);
    res.json({ data: { updated: true } });
  } catch (err) {
    handle(res, err, "outreach-update-contact");
  }
};

// DELETE /admin/outreach/contacts/:id
export const deleteContact = async (req: Request, res: Response) => {
  try {
    await OutreachService.deleteContact(req.params.id);
    res.status(204).send();
  } catch (err) {
    handle(res, err, "outreach-delete-contact");
  }
};

// POST /admin/outreach/contacts/:id/interactions
export const logInteraction = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const created = await OutreachService.logInteraction(req.params.id, {
      type: body.type,
      notes: body.notes ?? null,
      occurredAt: body.occurredAt ?? null,
    });
    res.status(201).json({ data: created });
  } catch (err) {
    handle(res, err, "outreach-log-interaction");
  }
};

// DELETE /admin/outreach/interactions/:id
export const deleteInteraction = async (req: Request, res: Response) => {
  try {
    await OutreachService.deleteInteraction(req.params.id);
    res.status(204).send();
  } catch (err) {
    handle(res, err, "outreach-delete-interaction");
  }
};

// POST /admin/outreach/contacts/:id/convert
// Body: same shape as POST /admin/affiliates (name, slug, contact_email, ...)
export const convertToAffiliate = async (req: Request, res: Response) => {
  try {
    const body = req.body ?? {};
    const result = await OutreachService.convertToAffiliate(
      req.params.id,
      body,
    );
    res.status(201).json({ data: result });
  } catch (err) {
    handle(res, err, "outreach-convert-to-affiliate");
  }
};

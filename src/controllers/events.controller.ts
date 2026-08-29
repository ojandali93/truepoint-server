// src/controllers/events.controller.ts
//
// POST /events/batch (authenticated) and POST /events/anonymous (public) —
// see events.service.ts for the validation/filtering split between them.

import { Request, Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  recordAnonymousEvents,
  recordEvents,
  type RawEventInput,
} from "../services/events.service";

const handleError = (res: Response, err: unknown) => {
  console.error("[EventsController]", err);
  res.status(500).json({ error: "An unexpected error occurred" });
};

const eventsFromBody = (body: unknown): RawEventInput[] | null => {
  if (!body || typeof body !== "object") return null;
  const events = (body as Record<string, unknown>).events;
  if (!Array.isArray(events)) return null;
  return events as RawEventInput[];
};

// POST /events/batch — authenticateUser applied at the route.
// Body: { events: [{ event, properties?, appVersion?, platform? }] }
export const postEventsBatch = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const events = eventsFromBody(req.body);
    if (!events) {
      res.status(400).json({ error: "events (array) is required" });
      return;
    }
    const result = await recordEvents(req.user.id, events);
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

// POST /events/anonymous — no auth. Restricted server-side (see
// events.service.ts::recordAnonymousEvents) to install_first_open /
// signup_started only — everything else in the batch is silently dropped.
export const postAnonymousEvents = async (req: Request, res: Response) => {
  try {
    const events = eventsFromBody(req.body);
    if (!events) {
      res.status(400).json({ error: "events (array) is required" });
      return;
    }
    const result = await recordAnonymousEvents(events);
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

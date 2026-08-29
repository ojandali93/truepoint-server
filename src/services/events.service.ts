// src/services/events.service.ts
//
// Usage + funnel instrumentation (UX_OVERHAUL_PLAN.md §5 Phase 1, B1).
// Two entry points, matching the two routes:
//
//   recordEvents           — authenticated batch, any of the 10 event names.
//   recordAnonymousEvents  — public batch, hard-restricted to the 2 events
//                             that can legitimately fire before an account
//                             exists (install_first_open, signup_started).
//                             Everything else in an anonymous batch is
//                             silently dropped, not errored — a client bug
//                             sending the wrong event type here shouldn't
//                             break the rest of that batch.
//
// EVENT_NAMES mirrors the DB CHECK constraint in
// migrations/2026-08-29_events.sql exactly. Validating here too (not just
// letting a bad insert bounce off the CHECK) means a malformed batch fails
// per-event, not as an all-or-nothing 400 for the whole request — one typo'd
// event name from a stale client build shouldn't drop the other 19 valid
// events in the same flush.

import { insertEvents, type EventInsert } from "../repositories/events.repository";

export const EVENT_NAMES = [
  "install_first_open",
  "signup_started",
  "signup_completed",
  "first_card_added",
  "first_grading_viewed",
  "import_completed",
  "paywall_viewed",
  "subscribe_started",
  "subscribe_completed",
  "feature_used",
] as const;

export type EventName = (typeof EVENT_NAMES)[number];

const ANONYMOUS_EVENT_NAMES: ReadonlySet<string> = new Set<EventName>([
  "install_first_open",
  "signup_started",
]);

// A single flush is client-batched (~15s or 20 events, whichever first —
// see mobile lib/events.ts) — 50 is generous headroom, not a real ceiling
// for honest use, but stops one request from writing an unbounded array.
const MAX_BATCH_SIZE = 50;

export interface RawEventInput {
  event: unknown;
  properties?: unknown;
  appVersion?: unknown;
  platform?: unknown;
}

const isEventName = (v: unknown): v is EventName =>
  typeof v === "string" && (EVENT_NAMES as readonly string[]).includes(v);

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const VALID_PLATFORMS = new Set(["ios", "android", "web"]);

/**
 * Normalizes one raw client event into an insert row, or null if it's
 * malformed / not allowed for this caller. `allowedNames` lets the two
 * entry points below share this exact same per-event validation instead of
 * duplicating it.
 */
const normalize = (
  raw: RawEventInput,
  userId: string | null,
  allowedNames: ReadonlySet<string> | null, // null = all EVENT_NAMES allowed
): EventInsert | null => {
  if (!isEventName(raw.event)) return null;
  if (allowedNames && !allowedNames.has(raw.event)) return null;

  const properties = isPlainObject(raw.properties) ? raw.properties : {};
  const appVersion = typeof raw.appVersion === "string" ? raw.appVersion : null;
  const platform =
    typeof raw.platform === "string" && VALID_PLATFORMS.has(raw.platform)
      ? raw.platform
      : null;

  return { userId, event: raw.event, properties, appVersion, platform };
};

/** Authenticated batch — any of the 10 event names, user_id from the session. */
export const recordEvents = async (
  userId: string,
  rawEvents: RawEventInput[],
): Promise<{ inserted: number; skipped: number }> => {
  const capped = rawEvents.slice(0, MAX_BATCH_SIZE);
  const rows = capped
    .map((raw) => normalize(raw, userId, null))
    .filter((r): r is EventInsert => r !== null);

  await insertEvents(rows);
  return { inserted: rows.length, skipped: capped.length - rows.length };
};

/**
 * Public batch — install_first_open / signup_started only, user_id always
 * null (even if a caller somehow tried to smuggle one through the body —
 * this endpoint has no session to attribute it to, so it's ignored, not
 * trusted).
 */
export const recordAnonymousEvents = async (
  rawEvents: RawEventInput[],
): Promise<{ inserted: number; skipped: number }> => {
  const capped = rawEvents.slice(0, MAX_BATCH_SIZE);
  const rows = capped
    .map((raw) => normalize(raw, null, ANONYMOUS_EVENT_NAMES))
    .filter((r): r is EventInsert => r !== null);

  await insertEvents(rows);
  return { inserted: rows.length, skipped: capped.length - rows.length };
};

// src/repositories/events.repository.ts
//
// Persistence for the events table (migrations/2026-08-29_events.sql — must
// be applied before any of these queries will succeed against a real
// database; applied and verified 2026-08-29). Bulk insert only — this table
// is write-once, append-only telemetry; nothing here ever updates or
// deletes a row.

import { supabaseAdmin } from "../lib/supabase";

const TABLE = "events";

export interface EventInsert {
  userId: string | null;
  event: string;
  properties: Record<string, unknown>;
  appVersion: string | null;
  platform: string | null;
}

/**
 * Bulk-inserts a batch of events. Empty input is a no-op (not an error) —
 * callers filter down to zero rows in normal operation (e.g. an anonymous
 * batch with nothing but disallowed event names).
 */
export const insertEvents = async (rows: EventInsert[]): Promise<void> => {
  if (rows.length === 0) return;

  const { error } = await supabaseAdmin.from(TABLE).insert(
    rows.map((r) => ({
      user_id: r.userId,
      event: r.event,
      properties: r.properties,
      app_version: r.appVersion,
      platform: r.platform,
    })),
  );
  if (error) throw error;
};

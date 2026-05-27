// src/services/push.service.ts
//
// Sends push notifications via Expo's push service. Token storage already
// exists (user_devices.push_token, populated on login via registerDevice).
// This module reads a user's active device tokens and delivers messages.
//
// Uses a raw fetch to Expo's push API (https://exp.host/--/api/v2/push/send)
// so no extra dependency is required. Expo accepts up to 100 messages per
// request; we chunk accordingly.
//
// Receipt handling note: Expo returns a "ticket" per message immediately, then
// receipts are available later. For V1 we handle tickets synchronously (detect
// DeviceNotRegistered to prune dead tokens) and skip the async receipt poll.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
const CHUNK_SIZE = 100;

export interface PushMessage {
  title: string;
  body: string;
  // Arbitrary data delivered to the app (e.g. a deep-link target).
  data?: Record<string, unknown>;
  // iOS badge count, optional.
  badge?: number;
  sound?: "default" | null;
}

interface ExpoTicket {
  status: "ok" | "error";
  id?: string;
  message?: string;
  details?: { error?: string };
}

// Expo push tokens look like ExponentPushToken[xxxx] or ExpoPushToken[xxxx].
const isExpoToken = (t: string | null | undefined): t is string =>
  !!t && /^Expo(nent)?PushToken\[/.test(t);

const chunk = <T>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

// ─── Fetch a user's active push tokens ──────────────────────────────────────

const getActiveTokensForUser = async (userId: string): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from("user_devices")
    .select("push_token")
    .eq("user_id", userId)
    .eq("is_active", true)
    .not("push_token", "is", null);

  if (error) throw error;
  const tokens = (data ?? [])
    .map((r: any) => r.push_token as string | null)
    .filter(isExpoToken);
  // De-dupe (same token could appear on multiple device rows)
  return Array.from(new Set(tokens));
};

// ─── Prune a dead token (Expo says DeviceNotRegistered) ─────────────────────

const pruneToken = async (token: string): Promise<void> => {
  await supabaseAdmin
    .from("user_devices")
    .update({ push_token: null })
    .eq("push_token", token);
};

// ─── Low-level: send to a list of tokens ────────────────────────────────────

const sendToTokens = async (
  tokens: string[],
  message: PushMessage,
): Promise<{ sent: number; failed: number }> => {
  if (tokens.length === 0) return { sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;

  for (const batch of chunk(tokens, CHUNK_SIZE)) {
    const payload = batch.map((to) => ({
      to,
      title: message.title,
      body: message.body,
      data: message.data ?? {},
      sound: message.sound === undefined ? "default" : message.sound,
      ...(message.badge != null ? { badge: message.badge } : {}),
    }));

    try {
      const res = await fetch(EXPO_PUSH_URL, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const json: any = await res.json();
      const tickets: ExpoTicket[] = json?.data ?? [];

      tickets.forEach((ticket, i) => {
        if (ticket.status === "ok") {
          sent++;
        } else {
          failed++;
          // Prune tokens Expo says are dead so we stop sending to them.
          if (ticket.details?.error === "DeviceNotRegistered") {
            void pruneToken(batch[i]);
          }
        }
      });
    } catch (err: any) {
      failed += batch.length;
      await logError({
        source: "push-send",
        message: err?.message ?? "Expo push request failed",
        error: err,
        userId: null,
        metadata: { batchSize: batch.length, title: message.title },
      });
    }
  }

  return { sent, failed };
};

// ─── Public: send to one user (all their active devices) ────────────────────

export const sendPushToUser = async (
  userId: string,
  message: PushMessage,
): Promise<{ sent: number; failed: number }> => {
  try {
    const tokens = await getActiveTokensForUser(userId);
    return await sendToTokens(tokens, message);
  } catch (err: any) {
    await logError({
      source: "push-send-user",
      message: err?.message ?? "Failed to send push to user",
      error: err,
      userId,
      metadata: { title: message.title },
    });
    return { sent: 0, failed: 0 };
  }
};

// ─── Public: send to many users (e.g. a broadcast) ──────────────────────────

export const sendPushToUsers = async (
  userIds: string[],
  message: PushMessage,
): Promise<{ sent: number; failed: number }> => {
  let sent = 0;
  let failed = 0;
  for (const userId of userIds) {
    const r = await sendPushToUser(userId, message);
    sent += r.sent;
    failed += r.failed;
  }
  return { sent, failed };
};

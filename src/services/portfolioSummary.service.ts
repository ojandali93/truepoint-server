// src/services/portfolioSummary.service.ts
//
// Sends a daily "portfolio summary" push to each user with inventory:
//   "Your portfolio: $X.XX  ·  +$Y.YY today"
//
// Reads the two most recent aggregate snapshots (collection_id IS NULL) to
// compute today-vs-yesterday change. Skips users who:
//   - have no push token (nothing to send to)
//   - have opted out (notification_settings.notify_price_alerts = false)
//   - have an empty portfolio (no value, nothing useful to say)
//
// Designed to run right after syncAllPortfolios writes the day's snapshots, so
// the latest snapshot is already current.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { sendPushToUser } from "./push.service";

const fmtUSD = (n: number) =>
  n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

interface SummaryResult {
  total: number;
  sent: number;
  skipped: number;
}

// Should this user receive the daily summary? (opt-out check)
const wantsSummary = async (userId: string): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("notification_settings")
    .select("notify_price_alerts")
    .eq("user_id", userId)
    .maybeSingle();
  // Default ON if no row exists (table default is true).
  if (!data) return true;
  return data.notify_price_alerts !== false;
};

// The two most recent aggregate snapshots for day-over-day change.
const getLatestTwoSnapshots = async (
  userId: string,
): Promise<{ today: number; prev: number | null } | null> => {
  const { data, error } = await supabaseAdmin
    .from("portfolio_snapshots")
    .select("total_value, snapshot_date")
    .eq("user_id", userId)
    .is("collection_id", null)
    .order("snapshot_date", { ascending: false })
    .limit(2);

  if (error) throw error;
  if (!data || data.length === 0) return null;

  const today = Number(data[0].total_value) || 0;
  const prev = data.length > 1 ? Number(data[1].total_value) || 0 : null;
  return { today, prev };
};

// Send the summary to one user. Returns true if a push was sent.
export const sendDailySummaryToUser = async (
  userId: string,
): Promise<boolean> => {
  const snaps = await getLatestTwoSnapshots(userId);
  if (!snaps) return false;

  // Empty portfolio — nothing worth notifying about.
  if (snaps.today <= 0) return false;

  if (!(await wantsSummary(userId))) return false;

  let body: string;
  if (snaps.prev == null) {
    body = `Your portfolio is worth ${fmtUSD(snaps.today)}.`;
  } else {
    const change = snaps.today - snaps.prev;
    const pct = snaps.prev > 0 ? (change / snaps.prev) * 100 : 0;
    const arrow = change > 0 ? "▲" : change < 0 ? "▼" : "•";
    const sign = change > 0 ? "+" : "";
    body =
      `Your portfolio: ${fmtUSD(snaps.today)}  ` +
      `${arrow} ${sign}${fmtUSD(change)} (${sign}${pct.toFixed(1)}%) today`;
  }

  const { sent } = await sendPushToUser(userId, {
    title: "TruePoint — Daily Summary",
    body,
    data: { type: "daily_summary", path: "/(app)/home" },
  });
  return sent > 0;
};

// Send to every user with inventory. Called by the daily cron after snapshots.
export const sendDailySummaries = async (): Promise<SummaryResult> => {
  let sent = 0;
  let skipped = 0;

  // Only users who have at least one push token — no point computing for the rest.
  const { data: deviceRows, error } = await supabaseAdmin
    .from("user_devices")
    .select("user_id")
    .not("device_token", "is", null);

  if (error) {
    await logError({
      source: "daily-summary",
      message: error.message ?? "Failed to list devices",
      error,
      userId: null,
    });
    return { total: 0, sent: 0, skipped: 0 };
  }

  const userIds = Array.from(
    new Set((deviceRows ?? []).map((r: any) => r.user_id as string)),
  ).filter(Boolean);

  for (const userId of userIds) {
    try {
      const didSend = await sendDailySummaryToUser(userId);
      if (didSend) sent++;
      else skipped++;
    } catch (err: any) {
      skipped++;
      await logError({
        source: "daily-summary-user",
        message: err?.message ?? "Failed to send daily summary",
        error: err,
        userId,
      });
    }
    // Gentle pacing
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `[DailySummary] Complete. Sent: ${sent}, Skipped: ${skipped}, Total: ${userIds.length}`,
  );
  return { total: userIds.length, sent, skipped };
};

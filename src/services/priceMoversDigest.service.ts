// src/services/priceMoversDigest.service.ts
//
// Sends each user ONE digest notification about their owned cards that made a
// notable move:
//   "3 of your cards are moving: Charizard ex +12% today · Umbreon +28% this
//    week · Pikachu +9% today"
//
// Qualify rule (per owned card):
//   - current value >= $25 (VALUE_FLOOR) — filters penny-card noise
//   - AND ( |daily change| >= 7.5%  OR  |weekly change| >= 25% )
//
// Daily + weekly are MERGED per card: a card shows the bigger-magnitude move,
// and if both qualify the line notes both. One notification per user, top N
// cards named, rest summarized as "+N more".
//
// Needs card_price_history populated (snapshotCardPrices). Until ~2 days of
// history exist nothing daily fires; ~8 days for weekly. That's expected — the
// digest stays quiet until the data is there.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import { sendPushToUser } from "./push.service";

const VALUE_FLOOR = 25; // dollars
const DAILY_PCT = 7.5; // %
const WEEKLY_PCT = 25; // %
const TOP_N = 3; // cards named in the notification

interface Mover {
  name: string;
  dailyPct: number | null;
  weeklyPct: number | null;
  value: number;
  bestMagnitude: number; // for ranking
}

// Opt-out check (reuse the price-alerts toggle).
const wantsDigest = async (userId: string): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("notification_settings")
    .select("notify_price_alerts")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return true; // default on
  return data.notify_price_alerts !== false;
};

// History lookup for one card: returns { today, yesterday, weekAgo } prices.
// Picks the highest-priority source row (tcgplayer first) to stay consistent.
const priceSeriesFor = (
  rows: any[],
): { today: number | null; prev: number | null; weekAgo: number | null } => {
  if (!rows || rows.length === 0)
    return { today: null, prev: null, weekAgo: null };

  // rows are already filtered to one card; sort by date desc
  const sorted = [...rows].sort((a, b) =>
    a.snapshot_date < b.snapshot_date ? 1 : -1,
  );

  const today = sorted[0] ? Number(sorted[0].market_price) : null;

  // yesterday = the most recent row strictly before today's date
  const todayDate = sorted[0]?.snapshot_date;
  const prevRow = sorted.find((r) => r.snapshot_date < todayDate);
  const prev = prevRow ? Number(prevRow.market_price) : null;

  // ~7 days ago: the row closest to (today - 7 days), at least 6 days back
  let weekAgo: number | null = null;
  if (todayDate) {
    const target = new Date(todayDate);
    target.setDate(target.getDate() - 7);
    const targetStr = target.toISOString().slice(0, 10);
    // closest row on or before target, else oldest available if >=6 days back
    const candidate =
      sorted.find((r) => r.snapshot_date <= targetStr) ??
      sorted[sorted.length - 1];
    if (candidate) {
      const daysBack =
        (new Date(todayDate).getTime() -
          new Date(candidate.snapshot_date).getTime()) /
        86400000;
      if (daysBack >= 6) weekAgo = Number(candidate.market_price);
    }
  }

  return { today, prev, weekAgo };
};

const pct = (now: number, then: number): number =>
  then > 0 ? ((now - then) / then) * 100 : 0;

// Compute the digest for one user. Returns the message, or null if nothing qualifies.
const buildDigestForUser = async (userId: string): Promise<string | null> => {
  // 1) The user's owned cards (distinct card_ids).
  const { data: invRows, error: invErr } = await supabaseAdmin
    .from("inventory")
    .select("card_id, item_type")
    .eq("user_id", userId)
    .eq("item_type", "raw_card")
    .not("card_id", "is", null);
  if (invErr) throw invErr;

  const cardIds = Array.from(
    new Set((invRows ?? []).map((r: any) => r.card_id as string)),
  ).filter(Boolean);
  if (cardIds.length === 0) return null;

  // 2) History for those cards over the last ~9 days.
  const since = new Date();
  since.setDate(since.getDate() - 9);
  const sinceStr = since.toISOString().slice(0, 10);

  const { data: histRows, error: histErr } = await supabaseAdmin
    .from("card_price_history")
    .select("card_id, market_price, snapshot_date, source")
    .in("card_id", cardIds)
    .gte("snapshot_date", sinceStr);
  if (histErr) throw histErr;
  if (!histRows || histRows.length === 0) return null;

  // 3) Card names for the qualifying cards.
  const { data: cardRows } = await supabaseAdmin
    .from("cards")
    .select("id, name")
    .in("id", cardIds);
  const nameById = new Map<string, string>(
    (cardRows ?? []).map((c: any) => [c.id, c.name as string]),
  );

  // 4) Group history by card, compute moves, apply thresholds.
  const byCard = new Map<string, any[]>();
  for (const r of histRows) {
    const arr = byCard.get(r.card_id) ?? [];
    arr.push(r);
    byCard.set(r.card_id, arr);
  }

  const movers: Mover[] = [];
  for (const [cardId, rows] of byCard) {
    const { today, prev, weekAgo } = priceSeriesFor(rows);
    if (today == null || today < VALUE_FLOOR) continue;

    const dailyPct = prev != null ? pct(today, prev) : null;
    const weeklyPct = weekAgo != null ? pct(today, weekAgo) : null;

    const dailyQual = dailyPct != null && Math.abs(dailyPct) >= DAILY_PCT;
    const weeklyQual = weeklyPct != null && Math.abs(weeklyPct) >= WEEKLY_PCT;
    if (!dailyQual && !weeklyQual) continue;

    movers.push({
      name: nameById.get(cardId) ?? "A card",
      dailyPct: dailyQual ? dailyPct : null,
      weeklyPct: weeklyQual ? weeklyPct : null,
      value: today,
      bestMagnitude: Math.max(
        dailyQual ? Math.abs(dailyPct!) : 0,
        weeklyQual ? Math.abs(weeklyPct!) : 0,
      ),
    });
  }

  if (movers.length === 0) return null;

  // 5) Rank by biggest move, build the merged one-line-per-card digest.
  movers.sort((a, b) => b.bestMagnitude - a.bestMagnitude);
  const top = movers.slice(0, TOP_N);

  const phrase = (m: Mover): string => {
    const parts: string[] = [];
    if (m.dailyPct != null) {
      const s = m.dailyPct > 0 ? "+" : "";
      parts.push(`${s}${m.dailyPct.toFixed(0)}% today`);
    }
    if (m.weeklyPct != null) {
      const s = m.weeklyPct > 0 ? "+" : "";
      parts.push(`${s}${m.weeklyPct.toFixed(0)}% this week`);
    }
    return `${m.name} ${parts.join(", ")}`;
  };

  const named = top.map(phrase).join(" · ");
  const more = movers.length - top.length;
  return more > 0 ? `${named} · +${more} more` : named;
};

// Send the digest to one user. Returns true if sent.
export const sendPriceMoversToUser = async (
  userId: string,
): Promise<boolean> => {
  if (!(await wantsDigest(userId))) return false;
  const body = await buildDigestForUser(userId);
  if (!body) return false;

  const count = body.split(" · ").length;
  const { sent } = await sendPushToUser(userId, {
    title:
      count > 1
        ? `${count} of your cards are moving`
        : "A card you own is moving",
    body,
    data: { type: "price_movers", path: "/(app)/home" },
  });
  return sent > 0;
};

// Send to every user with a push token. Called by the cron.
export const sendPriceMoversDigest = async (): Promise<{
  total: number;
  sent: number;
  skipped: number;
}> => {
  // ─── DISABLED ──────────────────────────────────────────────────────────────
  // The price-movers digest is turned off. It was not working correctly and is
  // being held back regardless. This no-op stops all sends even if the cron
  // (POST /sync/price-movers) keeps firing, without affecting the daily
  // portfolio-movement notifications, admin broadcasts, or one-off sends.
  // To re-enable later, set env PRICE_MOVERS_DIGEST_ENABLED=true and redeploy.
  if (process.env.PRICE_MOVERS_DIGEST_ENABLED !== "true") {
    console.log("[PriceMovers] digest disabled — skipping send");
    return { total: 0, sent: 0, skipped: 0 };
  }

  let sent = 0;
  let skipped = 0;

  const { data: deviceRows, error } = await supabaseAdmin
    .from("user_devices")
    .select("user_id")
    .not("device_token", "is", null);
  if (error) {
    await logError({
      source: "price-movers",
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
      const didSend = await sendPriceMoversToUser(userId);
      if (didSend) sent++;
      else skipped++;
    } catch (err: any) {
      skipped++;
      await logError({
        source: "price-movers-user",
        message: err?.message ?? "Failed to send price movers",
        error: err,
        userId,
      });
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log(
    `[PriceMovers] Complete. Sent: ${sent}, Skipped: ${skipped}, Total: ${userIds.length}`,
  );
  return { total: userIds.length, sent, skipped };
};

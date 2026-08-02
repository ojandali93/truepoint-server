// src/services/watchlistTriggers.service.ts
//
// Checks every watchlist item's buy/sell triggers against its CURRENT
// price and sends a push to that item's OWN user_id — never anyone else's
// — when a trigger newly crosses.
//
// Edge-triggered, not level-triggered: a trigger fires once at the moment
// of crossing, not on every check while price stays past the threshold.
// last_notified_buy_at / last_notified_sell_at (already on the table,
// added when watchlist_items was first built) record that a crossing was
// already notified; if price moves back past the threshold, the flag
// resets, so a genuine future re-crossing can notify again.
//
// dryRun computes and returns exactly what WOULD be sent — real title,
// real body, real recipient — without calling sendPushToUser or touching
// last_notified_*. This is what the admin targeted-send tool uses to
// verify content is correct before any real delivery happens.

import { supabaseAdmin } from "../lib/supabase";
import { sendPushToUser } from "./push.service";
import { getCurrentPriceLookup } from "./watchlist.service";
import { getAllFlags, evaluateFlag } from "./featureFlag.service";
import { FLAG_KEYS } from "../constants/featureFlagKeys";

const wantsPriceAlerts = async (userId: string): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("notification_settings")
    .select("notify_price_alerts")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) return true; // default on, matches every other digest's opt-out check
  return data.notify_price_alerts !== false;
};

export interface TriggerCheckResult {
  itemId: string;
  userId: string;
  triggerType: "buy" | "sell";
  itemName: string;
  currentPrice: number;
  targetPrice: number;
  title: string;
  body: string;
  sent: boolean;
  reason?: string; // "opted out" | "dry run" | "send failed"
}

export interface TriggerCheckSummary {
  itemsChecked: number;
  triggersFound: number;
  sent: number;
  results: TriggerCheckResult[];
}

/**
 * Checks watchlist items for newly-crossed triggers. `onlyUserId` scopes
 * the entire check to one account — every query, every push, everything —
 * this is not a filter applied after the fact, the DB query itself never
 * sees another user's rows when it's set. `dryRun` computes real content
 * against real data but sends nothing and mutates nothing.
 */
export const checkWatchlistTriggers = async (options?: {
  onlyUserId?: string;
  dryRun?: boolean;
}): Promise<TriggerCheckSummary> => {
  const onlyUserId = options?.onlyUserId;
  const dryRun = options?.dryRun ?? false;

  let query = supabaseAdmin
    .from("watchlist_items")
    .select(
      `
      id, user_id, card_id, product_id, target_company, target_grade,
      buy_below_price, sell_above_price,
      last_notified_buy_at, last_notified_sell_at,
      cards ( name, number ),
      products ( name )
    `,
    )
    .or("buy_below_price.not.is.null,sell_above_price.not.is.null");
  if (onlyUserId) query = query.eq("user_id", onlyUserId);

  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows?.length)
    return { itemsChecked: 0, triggersFound: 0, sent: 0, results: [] };

  const cardIds = [
    ...new Set(
      (rows as any[]).filter((r) => r.card_id).map((r) => r.card_id as string),
    ),
  ];
  const productIds = [
    ...new Set(
      (rows as any[])
        .filter((r) => r.product_id)
        .map((r) => r.product_id as string),
    ),
  ];
  const { rawPriceFor, gradedPriceFor, productPriceFor } =
    await getCurrentPriceLookup(cardIds, productIds);

  // Per-user gate — only relevant for the bulk sweep (onlyUserId unset).
  // The admin test tool always targets one explicit account and bypasses
  // this entirely, since verifying content BEFORE anyone is flagged in is
  // the whole point of that tool. Fetched once, evaluated per-row from
  // memory — getAllFlags() is already 30s-TTL cached, so this doesn't add
  // a query per user.
  const notifyFlag = onlyUserId
    ? null
    : ((await getAllFlags()).find(
        (f) => f.key === FLAG_KEYS.NOTIFY_WATCHLIST_TRIGGERS,
      ) ?? null);

  const results: TriggerCheckResult[] = [];
  let sentCount = 0;

  for (const r of rows as any[]) {
    if (!onlyUserId && !evaluateFlag(notifyFlag, r.user_id, null)) continue;

    const currentPrice: number | null = r.card_id
      ? r.target_company && r.target_grade
        ? gradedPriceFor(r.card_id, r.target_company, r.target_grade)
        : rawPriceFor(r.card_id)
      : productPriceFor(r.product_id);

    if (currentPrice == null) continue; // no price data — nothing to compare

    const name: string = r.card_id
      ? (r.cards?.name ?? "A card")
      : (r.products?.name ?? "A product");
    const gradeSuffix =
      r.target_company && r.target_grade
        ? ` (${r.target_company} ${r.target_grade})`
        : "";

    const handleTrigger = async (
      type: "buy" | "sell",
      targetPrice: number,
      crossed: boolean,
      alreadyNotified: boolean,
      lastNotifiedColumn: "last_notified_buy_at" | "last_notified_sell_at",
    ) => {
      if (crossed && !alreadyNotified) {
        const title = type === "buy" ? "Buy trigger hit" : "Sell trigger hit";
        const verb = type === "buy" ? "dropped to" : "rose to";
        const body = `${name}${gradeSuffix} ${verb} $${currentPrice!.toFixed(2)} — your target was $${targetPrice.toFixed(2)}.`;

        const result: TriggerCheckResult = {
          itemId: r.id,
          userId: r.user_id,
          triggerType: type,
          itemName: `${name}${gradeSuffix}`,
          currentPrice: currentPrice!,
          targetPrice,
          title,
          body,
          sent: false,
        };

        if (dryRun) {
          result.reason = "dry run";
          results.push(result);
          return;
        }

        const canSend = await wantsPriceAlerts(r.user_id);
        if (!canSend) {
          result.reason = "opted out";
          results.push(result);
          // Still mark as notified — the trigger DID cross, we just didn't
          // deliver by their own preference; don't re-evaluate every run.
          await supabaseAdmin
            .from("watchlist_items")
            .update({ [lastNotifiedColumn]: new Date().toISOString() })
            .eq("id", r.id);
          return;
        }

        const { sent } = await sendPushToUser(r.user_id, {
          title,
          body,
          data: { type: `watchlist_${type}`, watchlistItemId: r.id },
        });
        result.sent = sent > 0;
        if (!result.sent) result.reason = "send failed";
        else sentCount++;
        results.push(result);

        await supabaseAdmin
          .from("watchlist_items")
          .update({ [lastNotifiedColumn]: new Date().toISOString() })
          .eq("id", r.id);
      } else if (!crossed && alreadyNotified && !dryRun) {
        // Price recovered past the threshold — reset so a genuine future
        // re-crossing can notify again instead of staying silent forever.
        await supabaseAdmin
          .from("watchlist_items")
          .update({ [lastNotifiedColumn]: null })
          .eq("id", r.id);
      }
    };

    if (r.buy_below_price != null) {
      await handleTrigger(
        "buy",
        r.buy_below_price,
        currentPrice <= r.buy_below_price,
        !!r.last_notified_buy_at,
        "last_notified_buy_at",
      );
    }
    if (r.sell_above_price != null) {
      await handleTrigger(
        "sell",
        r.sell_above_price,
        currentPrice >= r.sell_above_price,
        !!r.last_notified_sell_at,
        "last_notified_sell_at",
      );
    }
  }

  return {
    itemsChecked: rows.length,
    triggersFound: results.length,
    sent: sentCount,
    results,
  };
};

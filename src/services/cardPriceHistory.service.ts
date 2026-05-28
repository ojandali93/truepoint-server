// src/services/cardPriceHistory.service.ts
//
// Snapshots the current market_prices cache into card_price_history, building
// the daily time series the price-movers digest needs. market_prices is
// overwritten on each price sync, so this must run AFTER prices refresh and
// BEFORE the next refresh — once per day, on the daily cron.
//
// Idempotent: re-running on the same day overwrites that day's rows (upsert on
// the unique index), so a double-fire doesn't create duplicates.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";

const PAGE = 1000;

// Copy every current market_prices row into history under today's date.
export const snapshotCardPrices = async (): Promise<{
  copied: number;
  date: string;
}> => {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let copied = 0;
  let from = 0;

  // Page through market_prices so we don't load the whole table at once.
  for (;;) {
    const { data, error } = await supabaseAdmin
      .from("market_prices")
      .select("card_id, source, variant, grade, market_price")
      .not("market_price", "is", null)
      .range(from, from + PAGE - 1);

    if (error) throw error;
    if (!data || data.length === 0) break;

    const rows = data.map((r: any) => ({
      card_id: r.card_id,
      source: r.source,
      variant: r.variant,
      grade: r.grade,
      market_price: r.market_price,
      snapshot_date: today,
    }));

    const { error: upErr } = await supabaseAdmin
      .from("card_price_history")
      .upsert(rows, {
        onConflict: "card_id,source,variant,grade,snapshot_date",
      });
    if (upErr) throw upErr;

    copied += rows.length;
    if (data.length < PAGE) break;
    from += PAGE;
  }

  console.log(`[CardPriceHistory] Snapshotted ${copied} prices for ${today}`);
  return { copied, date: today };
};

// Wrapper that logs instead of throwing — for fire-and-forget cron use.
export const snapshotCardPricesSafe = async (): Promise<void> => {
  try {
    await snapshotCardPrices();
  } catch (err: any) {
    await logError({
      source: "card-price-history",
      message: err?.message ?? "Failed to snapshot card prices",
      error: err,
      userId: null,
    });
  }
};

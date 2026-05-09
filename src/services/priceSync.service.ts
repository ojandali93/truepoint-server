// src/services/priceSync.service.ts
import { supabaseAdmin } from "../lib/supabase";
import { getAllPricesForCard } from "./pricing.service";

const BATCH_SIZE = 50;
const DELAY_MS = 400; // between cards — keeps API calls polite

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

export const syncAllCardPrices = async (): Promise<void> => {
  console.log("[PriceSync] Starting full card price sync...");

  // Create sync log entry
  const { data: syncLog } = await supabaseAdmin
    .from("price_sync_log")
    .insert({ sync_type: "cards", status: "running" })
    .select()
    .single();

  const syncId = syncLog?.id;
  let synced = 0;
  let failed = 0;

  // Pull all card IDs from your cards table
  const { data: cards, error } = await supabaseAdmin
    .from("cards")
    .select("id, name, set_id")
    .order("id")
    .limit(100000);

  if (error || !cards) {
    console.error("[PriceSync] Failed to fetch cards:", error);
    return;
  }

  console.log(`[PriceSync] Syncing prices for ${cards.length} cards...`);

  // Process in batches
  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);
    console.log(
      `[PriceSync] Batch ${Math.floor(i / BATCH_SIZE) + 1} of ${Math.ceil(cards.length / BATCH_SIZE)}`,
    );

    for (const card of batch) {
      try {
        await getAllPricesForCard(card.id, card.name, card.set_id);
        synced++;
      } catch (err: any) {
        console.error(`[PriceSync] Failed for card ${card.id}:`, err?.message);
        failed++;
      }
      await delay(DELAY_MS);
    }

    // Update progress every batch
    if (syncId) {
      await supabaseAdmin
        .from("price_sync_log")
        .update({
          synced_items: synced,
          failed_items: failed,
          total_items: cards.length,
        })
        .eq("id", syncId);
    }
  }

  // Mark complete
  if (syncId) {
    await supabaseAdmin
      .from("price_sync_log")
      .update({
        status: failed > cards.length * 0.1 ? "failed" : "completed",
        completed_at: new Date().toISOString(),
        synced_items: synced,
        failed_items: failed,
      })
      .eq("id", syncId);
  }

  console.log(`[PriceSync] Complete. Synced: ${synced}, Failed: ${failed}`);
};

// Check if a sync is needed (last sync > 48 hours ago)
export const shouldSyncPrices = async (): Promise<boolean> => {
  const { data } = await supabaseAdmin
    .from("price_sync_log")
    .select("completed_at")
    .eq("status", "completed")
    .eq("sync_type", "cards")
    .order("completed_at", { ascending: false })
    .limit(1)
    .single();

  if (!data?.completed_at) return true;

  const hoursSinceSync =
    (Date.now() - new Date(data.completed_at).getTime()) / (1000 * 60 * 60);
  return hoursSinceSync > 48;
};

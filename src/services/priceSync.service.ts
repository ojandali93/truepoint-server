// src/services/priceSync.service.ts
import { supabaseAdmin } from "../lib/supabase";
import { getAllPricesForCard } from "./pricing.service";

const BATCH_SIZE = 50;
const DELAY_MS = 400;
const PAGE_SIZE = 1000; // Supabase max rows per query

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

// ─── Fetch ALL cards using pagination ─────────────────────────────────────────
// Supabase caps single queries at 1000 rows.
// We paginate through all cards to get the full 20k+.

const fetchAllCards = async (): Promise<
  { id: string; name: string; set_id: string }[]
> => {
  const all: { id: string; name: string; set_id: string }[] = [];
  let page = 0;

  while (true) {
    const from = page * PAGE_SIZE;
    const to = from + PAGE_SIZE - 1;

    const { data, error } = await supabaseAdmin
      .from("cards")
      .select("id, name, set_id")
      .order("id")
      .range(from, to);

    if (error) {
      console.error("[PriceSync] fetchAllCards error:", error.message);
      break;
    }

    if (!data || data.length === 0) break;

    all.push(...data);
    console.log(
      `[PriceSync] Loaded cards ${from + 1}–${from + data.length} (total so far: ${all.length})`,
    );

    // If we got fewer than PAGE_SIZE we've hit the end
    if (data.length < PAGE_SIZE) break;

    page++;
  }

  return all;
};

// ─── Main sync ─────────────────────────────────────────────────────────────────

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

  // Fetch all cards with pagination
  const cards = await fetchAllCards();

  if (!cards.length) {
    console.error("[PriceSync] No cards found");
    return;
  }

  console.log(`[PriceSync] Syncing prices for ${cards.length} cards...`);

  // Process in batches
  const totalBatches = Math.ceil(cards.length / BATCH_SIZE);

  for (let i = 0; i < cards.length; i += BATCH_SIZE) {
    const batch = cards.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    console.log(`[PriceSync] Batch ${batchNum} of ${totalBatches}`);

    for (const card of batch) {
      try {
        // fetchGraded = false — raw TCGPlayer prices only during bulk sync
        // Graded prices fetched on-demand in card detail view
        await getAllPricesForCard(card.id, card.name, card.set_id, false);
        synced++;
      } catch (err: any) {
        console.error(`[PriceSync] Failed for ${card.id}:`, err?.message);
        failed++;
      }
      await delay(DELAY_MS);
    }

    // Update progress in DB every batch
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

// ─── Check if sync is needed ───────────────────────────────────────────────────

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

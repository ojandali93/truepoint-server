// src/services/poketracePriceSync.service.ts
//
// PokeTrace graded-pricing sync. Two access patterns:
//
//   1) DAILY BULK (cron) — syncInventoryCardPrices()
//      Pulls all distinct card_ids that appear in any user's inventory and
//      refreshes their graded prices. Keeps active users' portfolios accurate
//      without burning the daily API budget on cards no one owns.
//
//   2) ON-DEMAND (card detail screen) — fetchAndCacheGradedPrices(cardId)
//      Checks cache freshness, fetches from PokeTrace if stale/missing, caches
//      the result. First user pays 1-2s latency; everyone after gets cached.
//
// Both write to market_prices using the convention that inventory.repository's
// fetchCardPrices() already expects:
//   - source: "poketrace"  (raw cards still come from "tcgplayer")
//   - grade:  "PSA 10" / "BGS 9.5" / etc. — SPACE-separated, the parser splits
//   - market_price: PokeTrace's 7d-avg eBay sold price for that grade
//
// The existing inventory.repository parser splits row.grade on whitespace,
// lowercases parts[0], and builds keys like psa_10, bgs_9.5 — so as long as
// we write "PSA 10" form, every existing graded-card read path "just works".

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import {
  fetchCardsByTcgplayerIds,
  fetchCardByTcgplayerId,
  extractGradedPrices,
  PoketraceCard,
} from "../lib/poketraceClient";

// Cache TTL for graded prices in market_prices. Graded data updates slowly
// (eBay sold data refreshes nightly on PokeTrace's side), so 24h is plenty.
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// PokeTrace allows 20 ids per call. Pacing between batches keeps us under the
// per-second rate limit (typical Pro tier is 5-10 RPS).
const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Write helper — upsert graded prices for one card into market_prices ────

interface UpsertSummary {
  cardId: string;
  gradedRowsWritten: number;
  companiesSeen: string[];
}

const upsertGradedPricesForCard = async (
  card: PoketraceCard,
): Promise<UpsertSummary> => {
  const cardId = card.refs.tcgplayerId;
  if (!cardId) {
    return { cardId: "(unknown)", gradedRowsWritten: 0, companiesSeen: [] };
  }

  const graded = extractGradedPrices(card);
  if (graded.length === 0) {
    // Nothing graded to write; still record an empty cache marker so we don't
    // re-fetch this card every time someone views it. We write a single row
    // with source='poketrace_meta', grade=null, market_price=null, fresh
    // expires_at. The on-demand path checks for ANY poketrace row to decide
    // freshness.
    await supabaseAdmin.from("market_prices").upsert(
      {
        card_id: cardId,
        source: "poketrace_meta",
        variant: null,
        grade: null,
        low_price: null,
        mid_price: null,
        high_price: null,
        market_price: null,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "card_id,source,variant,grade" },
    );
    return { cardId, gradedRowsWritten: 0, companiesSeen: [] };
  }

  const now = new Date().toISOString();
  const expires = new Date(Date.now() + CACHE_TTL_MS).toISOString();

  // Build all rows for this card and upsert in one batch.
  const rows = graded.map((g) => ({
    card_id: cardId,
    source: "poketrace",
    variant: null,
    // "PSA 10" form — inventory.repository's parser splits on whitespace
    grade: g.gradeString,
    low_price: null,
    mid_price: null,
    high_price: null,
    market_price: g.marketPrice,
    fetched_at: now,
    expires_at: expires,
  }));

  const { error } = await supabaseAdmin
    .from("market_prices")
    .upsert(rows, { onConflict: "card_id,source,variant,grade" });

  if (error) throw error;

  // Also write the meta row so the freshness check works uniformly.
  await supabaseAdmin.from("market_prices").upsert(
    {
      card_id: cardId,
      source: "poketrace_meta",
      variant: null,
      grade: null,
      low_price: null,
      mid_price: null,
      high_price: null,
      market_price: null,
      fetched_at: now,
      expires_at: expires,
    },
    { onConflict: "card_id,source,variant,grade" },
  );

  return {
    cardId,
    gradedRowsWritten: rows.length,
    companiesSeen: Array.from(new Set(graded.map((g) => g.company))),
  };
};

// ─── Daily bulk: sync every card that's in any user's inventory ─────────────

export const syncInventoryCardPrices = async (): Promise<{
  uniqueCards: number;
  fetched: number;
  gradedRows: number;
  failed: number;
}> => {
  // Distinct card_ids across all users' inventory (raw and graded — graded
  // cards need graded prices, raw cards might too if owner later grades them).
  const { data: invRows, error } = await supabaseAdmin
    .from("inventory")
    .select("card_id")
    .not("card_id", "is", null);

  if (error) {
    await logError({
      source: "poketrace-bulk-sync",
      message: error.message ?? "Failed to read inventory card list",
      error,
      userId: null,
    });
    return { uniqueCards: 0, fetched: 0, gradedRows: 0, failed: 0 };
  }

  const cardIds = Array.from(
    new Set((invRows ?? []).map((r: any) => r.card_id as string)),
  ).filter(Boolean);

  if (cardIds.length === 0) {
    console.log("[PokeTrace] No inventory card_ids to sync.");
    return { uniqueCards: 0, fetched: 0, gradedRows: 0, failed: 0 };
  }

  let fetched = 0;
  let gradedRows = 0;
  let failed = 0;

  for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
    const batch = cardIds.slice(i, i + BATCH_SIZE);
    try {
      const cards = await fetchCardsByTcgplayerIds(batch);
      fetched += cards.length;

      for (const card of cards) {
        try {
          const summary = await upsertGradedPricesForCard(card);
          gradedRows += summary.gradedRowsWritten;
        } catch (err: any) {
          failed++;
          await logError({
            source: "poketrace-bulk-upsert",
            message: err?.message ?? "Failed to upsert card",
            error: err,
            userId: null,
          });
        }
      }
    } catch (err: any) {
      failed += batch.length;
      await logError({
        source: "poketrace-bulk-fetch",
        message: err?.message ?? "Batch fetch failed",
        error: err,
        userId: null,
      });
    }
    await sleep(BATCH_DELAY_MS);
  }

  console.log(
    `[PokeTrace] Bulk sync complete. Cards: ${cardIds.length}, Fetched: ${fetched}, Graded rows: ${gradedRows}, Failed: ${failed}`,
  );
  return {
    uniqueCards: cardIds.length,
    fetched,
    gradedRows,
    failed,
  };
};

// ─── On-demand: card detail screen calls this for a single card ─────────────

// Returns true if the poketrace_meta row for this card is fresh (within TTL).
const isCacheFresh = async (cardId: string): Promise<boolean> => {
  const { data, error } = await supabaseAdmin
    .from("market_prices")
    .select("expires_at")
    .eq("card_id", cardId)
    .eq("source", "poketrace_meta")
    .maybeSingle();
  if (error || !data) return false;
  return new Date(data.expires_at).getTime() > Date.now();
};

export interface OnDemandResult {
  cardId: string;
  cached: boolean; // true if served from cache (no fetch happened)
  gradedRowsWritten: number;
  companiesSeen: string[];
}

export const fetchAndCacheGradedPrices = async (
  cardId: string,
): Promise<OnDemandResult> => {
  // 1) Cache check
  if (await isCacheFresh(cardId)) {
    return {
      cardId,
      cached: true,
      gradedRowsWritten: 0,
      companiesSeen: [],
    };
  }

  // 2) Fetch live and upsert
  const card = await fetchCardByTcgplayerId(cardId);
  if (!card) {
    // PokeTrace doesn't have this card. Still write a meta row so we don't
    // hammer them with repeat misses — TTL means we'll retry tomorrow.
    await supabaseAdmin.from("market_prices").upsert(
      {
        card_id: cardId,
        source: "poketrace_meta",
        variant: null,
        grade: null,
        low_price: null,
        mid_price: null,
        high_price: null,
        market_price: null,
        fetched_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString(),
      },
      { onConflict: "card_id,source,variant,grade" },
    );
    return { cardId, cached: false, gradedRowsWritten: 0, companiesSeen: [] };
  }

  const summary = await upsertGradedPricesForCard(card);
  return {
    cardId,
    cached: false,
    gradedRowsWritten: summary.gradedRowsWritten,
    companiesSeen: summary.companiesSeen,
  };
};

// ─── Read helper — fetch graded prices for the card detail screen ───────────

export interface GradedPriceRow {
  company: string; // "PSA" / "BGS" / "CGC" / "SGC" / "TAG" / "ACE"
  grade: string; // "10" / "9.5" / etc.
  marketPrice: number;
  fetchedAt: string;
}

export const getGradedPricesForCard = async (
  cardId: string,
): Promise<GradedPriceRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("market_prices")
    .select("grade, market_price, fetched_at")
    .eq("card_id", cardId)
    .eq("source", "poketrace")
    .not("market_price", "is", null);

  if (error) {
    console.error("[PokeTrace] read error:", error.message);
    return [];
  }

  const rows: GradedPriceRow[] = [];
  for (const r of data ?? []) {
    if (!r.grade) continue;
    const parts = String(r.grade).trim().split(/\s+/);
    if (parts.length < 2) continue;
    rows.push({
      company: parts[0],
      grade: parts.slice(1).join(" "),
      marketPrice: Number(r.market_price),
      fetchedAt: r.fetched_at as string,
    });
  }
  return rows;
};

// Fire-and-forget wrapper for the cron path.
export const syncInventoryCardPricesSafe = async (): Promise<void> => {
  try {
    await syncInventoryCardPrices();
  } catch (err: any) {
    await logError({
      source: "poketrace-bulk",
      message: err?.message ?? "Bulk sync threw",
      error: err,
      userId: null,
    });
  }
};

// ─── FULL CATALOG: sync every card in the cards table ───────────────────────
//
// This is the daily cron path. Iterates every card that belongs to a set with
// `tcgapis_group_id IS NOT NULL` (the "valid catalog" filter the rest of the
// app uses), fetches its graded prices from PokeTrace, and upserts them into
// market_prices.
//
// Budget math (PokeTrace allows 100k req/day):
//   Catalog cards: ~20-30k after filtering invalid sets
//   Batch size:    20 per API call
//   Requests:      ~1,000-1,500 per run (1-1.5% of daily budget)
//   Duration:      ~10-25 minutes at the existing 300ms batch delay
//
// Designed to be safe to re-run mid-day: upserts (no duplicates), idempotent.
// If interrupted, the next run just re-fetches everything.

export const syncAllCatalogGradedPrices = async (): Promise<{
  uniqueCards: number;
  fetched: number;
  gradedRows: number;
  failed: number;
  durationMs: number;
}> => {
  const startedAt = Date.now();

  // Pull every card_id whose set is in the valid catalog. The join filter
  // mirrors what card.repository.ts findAllSets() uses.
  const { data: cardRows, error } = await supabaseAdmin
    .from("cards")
    .select("id, sets!inner(tcgapis_group_id)")
    .not("sets.tcgapis_group_id", "is", null);

  if (error) {
    await logError({
      source: "poketrace-catalog-sync",
      message: error.message ?? "Failed to read catalog card list",
      error,
      userId: null,
    });
    return {
      uniqueCards: 0,
      fetched: 0,
      gradedRows: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  const cardIds = Array.from(
    new Set((cardRows ?? []).map((r: any) => r.id as string)),
  ).filter(Boolean);

  if (cardIds.length === 0) {
    console.log("[PokeTrace] No catalog card_ids to sync.");
    return {
      uniqueCards: 0,
      fetched: 0,
      gradedRows: 0,
      failed: 0,
      durationMs: Date.now() - startedAt,
    };
  }

  console.log(
    `[PokeTrace] Catalog sync starting. ${cardIds.length} cards, ${Math.ceil(cardIds.length / BATCH_SIZE)} batches.`,
  );

  let fetched = 0;
  let gradedRows = 0;
  let failed = 0;

  for (let i = 0; i < cardIds.length; i += BATCH_SIZE) {
    const batch = cardIds.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    const totalBatches = Math.ceil(cardIds.length / BATCH_SIZE);

    try {
      const cards = await fetchCardsByTcgplayerIds(batch);
      fetched += cards.length;

      for (const card of cards) {
        try {
          const summary = await upsertGradedPricesForCard(card);
          gradedRows += summary.gradedRowsWritten;
        } catch (err: any) {
          failed++;
          await logError({
            source: "poketrace-catalog-upsert",
            message: err?.message ?? "Failed to upsert card",
            error: err,
            userId: null,
          });
        }
      }

      // Progress log every 10 batches so cron-job.org execution logs are useful
      if (batchNum % 10 === 0 || batchNum === totalBatches) {
        console.log(
          `[PokeTrace] Catalog sync progress: batch ${batchNum}/${totalBatches}, fetched=${fetched}, gradedRows=${gradedRows}, failed=${failed}`,
        );
      }
    } catch (err: any) {
      failed += batch.length;
      await logError({
        source: "poketrace-catalog-fetch",
        message: err?.message ?? "Batch fetch failed",
        error: err,
        userId: null,
      });
    }
    await sleep(BATCH_DELAY_MS);
  }

  const durationMs = Date.now() - startedAt;
  console.log(
    `[PokeTrace] Catalog sync complete. Cards: ${cardIds.length}, Fetched: ${fetched}, Graded rows: ${gradedRows}, Failed: ${failed}, Duration: ${Math.round(durationMs / 1000)}s`,
  );

  return {
    uniqueCards: cardIds.length,
    fetched,
    gradedRows,
    failed,
    durationMs,
  };
};

// Fire-and-forget wrapper for the cron path.
export const syncAllCatalogGradedPricesSafe = async (): Promise<void> => {
  try {
    await syncAllCatalogGradedPrices();
  } catch (err: any) {
    await logError({
      source: "poketrace-catalog-sync",
      message: err?.message ?? "Catalog sync threw",
      error: err,
      userId: null,
    });
  }
};

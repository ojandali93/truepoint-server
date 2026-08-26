// src/services/pricechartingPriceSync.service.ts
//
// PriceCharting graded-pricing sync. Deliberately a SEPARATE service from
// poketracePriceSync.service.ts — not bolted onto it, per the approved
// plan — even though the two write to the same market_prices table with
// the same upsert shape. Writes source='pricecharting' rows at the
// grade-10 tier and BGS 10 Black Label / CGC 10 Pristine only; CLAUDE.md
// §6 already excludes everything below 10 from ever being read from this
// source, so this sync doesn't bother fetching/writing those fields.
//
// Demand set = inventory (ALL users, distinct card_id) ∪ watchlist_items
// with a graded target (target_company/target_grade set). ai_grading_reports
// is a documented no-op (see BACKLOG.md) — 0/107 reports in the last 90d
// have a resolvable card_id, so it contributes nothing today.
//
// Sizing (verified 2026-08-25): 494 unique cards in the demand set today.
// At the 1.1s throttle enforced inside pricechartingClient.ts, that's ~9
// minutes. Growth ceiling: ~3,500 cards ≈ 1 hour at this same rate — no
// parallelization is possible (PriceCharting's limit is a hard 1/sec), so
// revisit design (narrow the demand set, or accept a longer cron window) if
// the union set approaches that.
//
// RESUMABLE BY NIGHTLY RESWEEP, not by checkpoint — matches the existing
// poketracePriceSync.service.ts model exactly. Every card is upserted
// individually, immediately after its own fetch — never accumulated into a
// batch written at the end. A Render redeploy mid-run kills the in-memory
// loop but leaves every card processed so far correctly committed; the next
// run does a full fresh sweep, which self-heals whatever the previous run
// didn't reach. No separate progress/cursor table.

import { supabaseAdmin } from "../lib/supabase";
import { logError } from "../lib/Logger";
import {
  findProductByTcgId,
  extractTenTierPrices,
} from "../lib/pricechartingClient";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// ─── Demand set ───────────────────────────────────────────────────────────

export interface DemandCard {
  cardId: string;
  name: string;
  number: string | null;
  setName: string | null;
}

// Plain paginated scan (not fetchAllByIn — that's for IN-filtered chunked
// fetches; these are full-table scans over a small/growing table). Follows
// the same .range() pattern, per CLAUDE.md's PostgREST 1000-row-cap note.
async function scanAll<T>(
  table: string,
  columns: string,
  modify: (q: any) => any = (q) => q,
): Promise<T[]> {
  const pageSize = 1000;
  let out: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await modify(
      supabaseAdmin.from(table).select(columns),
    ).range(from, from + pageSize - 1);
    if (error) throw error;
    out = out.concat((data ?? []) as T[]);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

/**
 * Build today's demand set: distinct card_ids from all users' inventory,
 * plus watchlist_items with a graded target, resolved to name/number/set
 * for PriceCharting's full-text search. See file header for what's
 * deliberately excluded (ai_grading_reports) and why.
 */
export const buildDemandSet = async (): Promise<DemandCard[]> => {
  const invRows = await scanAll<{ card_id: string | null }>(
    "inventory",
    "card_id",
    (q) => q.not("card_id", "is", null),
  );
  const watchRows = await scanAll<{ card_id: string | null }>(
    "watchlist_items",
    "card_id",
    (q) => q.not("card_id", "is", null).not("target_grade", "is", null),
  );

  const cardIds = [
    ...new Set(
      [...invRows, ...watchRows]
        .map((r) => r.card_id)
        .filter((id): id is string => !!id),
    ),
  ];
  if (!cardIds.length) return [];

  // Two-step fetch (card_id → cards → sets) per CLAUDE.md's PostgREST
  // embedded-join caveat — no declared FK relied on here, plain lookups.
  const CHUNK = 300;
  const cardMap = new Map<string, { name: string; number: string | null; set_id: string | null }>();
  for (let i = 0; i < cardIds.length; i += CHUNK) {
    const chunk = cardIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("cards")
      .select("id, name, number, set_id")
      .in("id", chunk);
    if (error) throw error;
    for (const row of data ?? []) {
      cardMap.set(row.id, { name: row.name, number: row.number, set_id: row.set_id });
    }
  }

  const setIds = [...new Set([...cardMap.values()].map((c) => c.set_id).filter((id): id is string => !!id))];
  const setMap = new Map<string, string>();
  for (let i = 0; i < setIds.length; i += CHUNK) {
    const chunk = setIds.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin.from("sets").select("id, name").in("id", chunk);
    if (error) throw error;
    for (const row of data ?? []) setMap.set(row.id, row.name);
  }

  const out: DemandCard[] = [];
  for (const cardId of cardIds) {
    const card = cardMap.get(cardId);
    if (!card) continue; // stale card_id (deleted card) — skip, not an error
    out.push({
      cardId,
      name: card.name,
      number: card.number,
      setName: card.set_id ? (setMap.get(card.set_id) ?? null) : null,
    });
  }
  return out;
};

// ─── Write helper — one card, one upsert, immediately ────────────────────

interface CardSyncResult {
  cardId: string;
  matched: boolean;
  gradedRowsWritten: number;
}

export const syncOneCard = async (card: DemandCard): Promise<CardSyncResult> => {
  const product = await findProductByTcgId(card.name, card.setName, card.cardId);

  if (!product) {
    // No PriceCharting match (search miss OR they don't carry this card —
    // indistinguishable, see pricechartingClient.ts). Write a meta marker so
    // the on-demand path (future) doesn't re-search this card every time,
    // mirroring poketrace_meta's role for the PokeTrace sync.
    await supabaseAdmin.from("market_prices").upsert(
      {
        card_id: card.cardId,
        source: "pricecharting_meta",
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
    return { cardId: card.cardId, matched: false, gradedRowsWritten: 0 };
  }

  const graded = extractTenTierPrices(product);
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + CACHE_TTL_MS).toISOString();

  if (graded.length > 0) {
    const rows = graded.map((g) => ({
      card_id: card.cardId,
      source: "pricecharting",
      variant: null,
      grade: g.gradeString, // "PSA 10" / "BGS 10 Black" / "CGC 10 Pristine" / ...
      low_price: null,
      mid_price: null,
      high_price: null,
      market_price: g.marketPrice, // already dollars — cents/100 happened in the client
      // PriceCharting's own product id — was coming back on every search
      // response and being discarded before this. Needed for the per-card
      // attribution linkback (https://www.pricecharting.com/game/<id>,
      // verified live to 301-redirect to the canonical product page); see
      // migrations/2026-08-26_market_prices_source_product_id.sql.
      source_product_id: product.id,
      fetched_at: now,
      expires_at: expires,
    }));
    const { error } = await supabaseAdmin
      .from("market_prices")
      .upsert(rows, { onConflict: "card_id,source,variant,grade" });
    if (error) throw error;
  }

  // Meta row unconditionally (even with 0 graded rows — a match with no
  // 10-tier pricing yet is still "we checked, nothing there right now").
  // Carries source_product_id too when we have it — harmless on a meta
  // row (never read as a price), but keeps it available if this row is
  // ever consulted for the linkback outside the graded-rows path.
  await supabaseAdmin.from("market_prices").upsert(
    {
      card_id: card.cardId,
      source: "pricecharting_meta",
      variant: null,
      grade: null,
      low_price: null,
      mid_price: null,
      high_price: null,
      market_price: null,
      source_product_id: product.id,
      fetched_at: now,
      expires_at: expires,
    },
    { onConflict: "card_id,source,variant,grade" },
  );

  return { cardId: card.cardId, matched: true, gradedRowsWritten: graded.length };
};

// ─── Bulk sync — the nightly cron path ────────────────────────────────────

export interface PriceChartingSyncSummary {
  demandSetSize: number;
  processed: number;
  matched: number;
  gradedRowsWritten: number;
  failed: number;
  unmatched: DemandCard[];
  failedCards: Array<{ card: DemandCard; error: string }>;
}

/**
 * cardsOverride lets a caller (the manual small-slice verification run, or
 * a future on-demand path) sync a specific subset instead of the full
 * demand set — same per-card-commit function either way, so there's no
 * separate code path to drift from the real sync.
 */
export const syncPriceChartingPrices = async (
  cardsOverride?: DemandCard[],
): Promise<PriceChartingSyncSummary> => {
  const cards = cardsOverride ?? (await buildDemandSet());

  let processed = 0;
  let matched = 0;
  let gradedRowsWritten = 0;
  let failed = 0;
  const unmatched: DemandCard[] = [];
  const failedCards: Array<{ card: DemandCard; error: string }> = [];

  for (const card of cards) {
    try {
      const result = await syncOneCard(card);
      processed++;
      if (result.matched) matched++;
      else unmatched.push(card);
      gradedRowsWritten += result.gradedRowsWritten;
    } catch (err: any) {
      failed++;
      failedCards.push({ card, error: err?.message ?? String(err) });
      await logError({
        source: "pricecharting-sync",
        message: err?.message ?? "Failed to sync card",
        error: err,
        userId: null,
        metadata: { cardId: card.cardId, name: card.name },
      });
    }
  }

  console.log(
    `[PriceCharting] Sync complete. Demand set: ${cards.length}, Processed: ${processed}, ` +
      `Matched: ${matched}, Graded rows: ${gradedRowsWritten}, Failed: ${failed}`,
  );

  return {
    demandSetSize: cards.length,
    processed,
    matched,
    gradedRowsWritten,
    failed,
    unmatched,
    failedCards,
  };
};

// Fire-and-forget wrapper for the cron path — mirrors
// poketracePriceSync.service.ts's syncInventoryCardPricesSafe exactly.
export const syncPriceChartingPricesSafe = async (): Promise<void> => {
  try {
    await syncPriceChartingPrices();
  } catch (err: any) {
    await logError({
      source: "pricecharting-sync-fatal",
      message: err?.message ?? "PriceCharting sync threw",
      error: err,
      userId: null,
    });
  }
};

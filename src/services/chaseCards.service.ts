/**
 * Chase card scoring — replaces "top 5 by raw price" with a statistical
 * definition: how much of an outlier a card's price is relative to its
 * OWN set's median, weighted by rarity tier. A card priced 3x its set's
 * median is a real outlier regardless of whether it lands 3rd or 8th
 * most expensive in that specific set — a fixed top-N cutoff misses that
 * some sets genuinely have more (or fewer) than 5 real chase cards.
 *
 * Deliberately NOT an AI call. This is a numbers problem — same card,
 * same price, same rarity should always produce the same answer, and a
 * formula computes instantly at catalog scale where an AI call per card
 * would be slow, costly, and inconsistent run to run for no benefit.
 *
 * Runs as part of the existing price sync (see variantPriceSync.service.ts
 * — syncAllVariantPrices calls recomputeChaseCardsForSet per set, right
 * after that set's prices refresh), not on-demand — pre-computed and
 * stored on cards.is_chase_card / cards.chase_score so the "all chase
 * cards across every set" browse screen is a fast indexed read, not an
 * expensive live cross-catalog computation on every page load.
 */

import { supabaseAdmin } from "../lib/supabase";

// Same ordering already used for rarity-sort on the browse set grid
// (web's cards/[setId]/page.tsx) — reused here rather than inventing a
// second, possibly-inconsistent tier list.
const RARITY_ORDER = [
  "Special Illustration Rare",
  "Hyper Rare",
  "Illustration Rare",
  "Ultra Rare",
  "Double Rare",
  "Rare Holo",
  "Rare",
  "Uncommon",
  "Common",
  "Promo",
];

// Position 0 (rarest) → 1.0, unrecognized/unlisted rarity → a moderate
// default rather than 0, since an unmapped rarity string shouldn't
// silently zero out an otherwise-legitimate price outlier.
const rarityWeight = (rarity: string | null): number => {
  if (!rarity) return 0.5;
  const idx = RARITY_ORDER.indexOf(rarity);
  if (idx === -1) return 0.5;
  return 1 - idx / (RARITY_ORDER.length - 1); // 1.0 (rarest) → 0.0 (Promo)
};

const median = (nums: number[]): number => {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

// A card must be at least this many times its set's median to even be
// considered — prevents a uniformly-cheap set from flagging "chase
// cards" that are still basically worthless in absolute terms.
const MIN_PRICE_RATIO = 2;
// Score threshold, AFTER rarity weighting — see computeScore below.
const CHASE_SCORE_THRESHOLD = 1.4;
// Hard cap per set — a set where prices are unusually uniform-high
// shouldn't flag dozens of "chase" cards.
const MAX_CHASE_PER_SET = 8;

const computeScore = (priceRatio: number, rarity: string | null): number =>
  priceRatio * (0.5 + 0.5 * rarityWeight(rarity));

interface CardPriceRow {
  id: string;
  rarity: string | null;
  maxPrice: number;
}

/**
 * Recomputes chase-card status for EVERY set, using whatever prices are
 * already cached in market_prices — does NOT re-fetch from TCGAPIs, so
 * this is fast enough to trigger on demand rather than waiting for the
 * next scheduled price sync. Useful right after adding this feature
 * (existing cards default to is_chase_card=false until something
 * recomputes them), or any time you want current results without a full
 * price refresh.
 */
export const recomputeChaseCardsForAllSets = async (): Promise<{
  setsProcessed: number;
  totalChaseCards: number;
  failed: number;
}> => {
  const { data: sets } = await supabaseAdmin.from("sets").select("id");

  let setsProcessed = 0;
  let totalChaseCards = 0;
  let failed = 0;

  for (const set of sets ?? []) {
    try {
      const r = await recomputeChaseCardsForSet(set.id);
      totalChaseCards += r.chaseCount;
      setsProcessed++;
    } catch (err: any) {
      failed++;
      console.error(`[ChaseCards] set ${set.id} failed:`, err?.message);
    }
  }

  return { setsProcessed, totalChaseCards, failed };
};

/**
 * Recomputes chase-card status for every card in one set. Call this
 * AFTER that set's prices have been refreshed — it reads directly from
 * market_prices, so stale prices in → stale chase status out.
 */
export const recomputeChaseCardsForSet = async (
  setId: string,
): Promise<{ cardsScored: number; chaseCount: number }> => {
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("id, rarity")
    .eq("set_id", setId);

  if (!cards || cards.length === 0) {
    return { cardsScored: 0, chaseCount: 0 };
  }

  const cardIds = cards.map((c) => c.id);

  const { data: priceRows } = await supabaseAdmin
    .from("market_prices")
    .select("card_id, market_price, mid_price, low_price, high_price")
    .in("card_id", cardIds)
    .is("grade", null); // raw prices only — chase status is about the card, not one grade

  const maxPriceByCard = new Map<string, number>();
  for (const row of priceRows ?? []) {
    const price =
      (row as any).market_price ??
      (row as any).mid_price ??
      (row as any).low_price ??
      (row as any).high_price;
    if (price == null) continue;
    const num = Number(price);
    if (!isFinite(num) || num <= 0) continue;
    const current = maxPriceByCard.get((row as any).card_id) ?? 0;
    if (num > current) maxPriceByCard.set((row as any).card_id, num);
  }

  const priced: CardPriceRow[] = cards
    .map((c) => ({
      id: c.id,
      rarity: c.rarity,
      maxPrice: maxPriceByCard.get(c.id) ?? 0,
    }))
    .filter((c) => c.maxPrice > 0);

  if (priced.length === 0) {
    return { cardsScored: cards.length, chaseCount: 0 };
  }

  const setMedian = median(priced.map((c) => c.maxPrice));
  if (setMedian <= 0) {
    return { cardsScored: cards.length, chaseCount: 0 };
  }

  const scored = priced
    .map((c) => {
      const priceRatio = c.maxPrice / setMedian;
      return {
        id: c.id,
        priceRatio,
        score: computeScore(priceRatio, c.rarity),
      };
    })
    .filter((c) => c.priceRatio >= MIN_PRICE_RATIO)
    .filter((c) => c.score >= CHASE_SCORE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CHASE_PER_SET);

  const chaseIds = new Set(scored.map((c) => c.id));
  const now = new Date().toISOString();

  // Reset every card in this set first (cheap — one set at a time), then
  // write scores for the ones that actually qualify. Avoids leaving a
  // stale is_chase_card=true on a card that no longer qualifies (price
  // dropped, or was outscored by something new this cycle).
  await supabaseAdmin
    .from("cards")
    .update({ is_chase_card: false, chase_score: null, chase_computed_at: now })
    .eq("set_id", setId);

  for (const c of scored) {
    await supabaseAdmin
      .from("cards")
      .update({
        is_chase_card: true,
        chase_score: c.score,
        chase_computed_at: now,
      })
      .eq("id", c.id);
  }

  return { cardsScored: cards.length, chaseCount: chaseIds.size };
};

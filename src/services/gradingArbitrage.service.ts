// src/services/gradingArbitrage.service.ts
// Calculates grading ROI for raw cards in a user's inventory.
// For each raw card: fetches raw price + graded prices (PSA/BGS/CGC),
// computes profit and ROI after grading costs, ranks by opportunity.
//
// sourceAllowedAtTier gating added 2026-08-26 (Omar's build-26-blocker
// ruling): this is a paid-decision surface — a user pays real money to
// grade a card based on this ROI. Before this fix it read every source
// unconditionally, so a stray PokeTrace row at the 10-tier could get
// blended in alongside (or instead of) PriceCharting once the flag opens,
// silently overstating or understating the recommendation. Same
// flag-aware gate as fetchCardPrices/getGradedPricesForCard, imported
// from the shared lib rather than re-derived — see gradedPricePrecedence.ts.

import { supabaseAdmin } from "../lib/supabase";
import { fetchAllByIn } from "../lib/pgFetchAll";
import { parseGradeString, sourceAllowedAtTier } from "../lib/gradedPricePrecedence";

// ─── Grading costs (USD) ──────────────────────────────────────────────────────
// Standard tier pricing as of 2025. These are approximate — user can override.

export const GRADING_COSTS: Record<string, Record<string, number>> = {
  PSA: {
    value: 25, // Value (cards declared ≤$499)
    regular: 50, // Regular (≤$999)
    express: 150, // Express
    walkthrough: 600, // Walkthrough (same day)
  },
  BGS: {
    economy: 22,
    standard: 35,
    express: 80,
    premium: 200,
  },
  CGC: {
    economy: 20,
    standard: 30,
    express: 60,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GradePrice {
  company: string; // PSA | BGS | CGC | EBAY
  grade: string; // 10 | 9 | 9.5 etc
  price: number;
  source: string; // cardmarket | ebay
  // PriceCharting attribution linkback (CLAUDE.md license note) — null for
  // every other source, and for pricecharting rows synced before
  // migrations/2026-08-26_market_prices_source_product_id.sql landed.
  sourceProductId: string | null;
}

export interface ArbitrageOpportunity {
  inventoryId: string;
  cardId: string;
  cardName: string;
  cardNumber: string;
  setName: string;
  setId: string;
  imageSmall: string | null;
  rarity: string | null;
  rawPrice: number | null;
  purchasePrice: number | null;
  gradePrices: GradePrice[];
  bestGrade: GradePrice | null;
  bestProfit: number | null; // after grading cost
  bestROI: number | null; // percentage
  gradingCostUsed: number;
  recommendation: "strong_buy" | "buy" | "marginal" | "hold" | "no_data";
}

export interface ArbitrageSummary {
  totalRawCards: number;
  cardsWithData: number;
  strongBuy: number;
  buy: number;
  marginal: number;
  hold: number;
  topOpportunities: ArbitrageOpportunity[];
  allOpportunities: ArbitrageOpportunity[];
}

// ─── Classify recommendation ──────────────────────────────────────────────────

const classify = (
  roi: number | null,
): ArbitrageOpportunity["recommendation"] => {
  if (roi === null) return "no_data";
  if (roi >= 300) return "strong_buy";
  if (roi >= 100) return "buy";
  if (roi >= 30) return "marginal";
  return "hold";
};

// ─── Grade-price gating — pure, unit-testable without inventory setup ────────

export interface RawGradeRow {
  source: string;
  grade: string | null;
  market_price: number | null;
  source_product_id: string | null;
}

/**
 * Pure filter+map+sort step, split out from getGradingArbitrage so the
 * precedence logic is unit-testable against synthetic/live rows for one
 * card without needing that card to actually be owned in some test user's
 * inventory — see scripts/validateGradedPricePrecedence.ts. No I/O, no
 * async. Same source gate as fetchCardPrices/getGradedPricesForCard: flag
 * off = poketrace-only, unconditionally; flag on = tier-partitioned per
 * the locked contract, no blending.
 */
export const filterGradePricesForCard = (
  rows: RawGradeRow[],
  useNewPrecedence: boolean,
): GradePrice[] =>
  rows
    .filter((p) => p.grade && p.market_price)
    .map((p) => ({ row: p, parsed: parseGradeString(p.grade) }))
    .filter((x): x is { row: RawGradeRow; parsed: NonNullable<ReturnType<typeof parseGradeString>> } => x.parsed !== null)
    .filter(({ row, parsed }) =>
      useNewPrecedence
        ? sourceAllowedAtTier(row.source, parsed.gradeValue)
        : row.source === "poketrace",
    )
    // parsed.gradeValue carries the FULL value ("10 Black", "10 Pristine"),
    // not just its leading numeric token — a plain `parts[1]` split here
    // truncated "BGS 10 Black" down to "10", indistinguishable from a real
    // bare "BGS 10" row (backlogged 2026-08-26, upgraded to a pre-flag-open
    // blocker; see CLAUDE.md §6). Reusing parseGradeString rather than
    // re-deriving keeps this in the one place the split logic is allowed
    // to live — see gradedPricePrecedence.ts's own header comment.
    .map(({ row, parsed }) => ({
      company: parsed.company,
      grade: parsed.gradeValue,
      price: row.market_price!,
      source: row.source,
      sourceProductId: row.source_product_id ?? null,
    }))
    .sort((a, b) => b.price - a.price);

// ─── Main service ─────────────────────────────────────────────────────────────

export const getGradingArbitrage = async (
  userId: string,
  gradingService: string = "PSA",
  gradingTier: string = "value",
  targetGrade: string = "10",
  useNewPrecedence: boolean = false,
): Promise<ArbitrageSummary> => {
  const gradingCost = GRADING_COSTS[gradingService]?.[gradingTier] ?? 25;

  // Get all raw cards from user's inventory
  const { data: inventory } = await supabaseAdmin
    .from("inventory")
    .select(
      `
      id,
      card_id,
      purchase_price,
      cards!inner (
        id,
        name,
        number,
        rarity,
        image_small,
        set_id,
        sets!inner ( name )
      )
    `,
    )
    .eq("user_id", userId)
    .eq("item_type", "raw_card")
    .not("card_id", "is", null);

  if (!inventory?.length) {
    return {
      totalRawCards: 0,
      cardsWithData: 0,
      strongBuy: 0,
      buy: 0,
      marginal: 0,
      hold: 0,
      topOpportunities: [],
      allOpportunities: [],
    };
  }

  const cardIds = [...new Set(inventory.map((i) => i.card_id as string))];

  // Fetch all prices for these cards. Use the paginated helper: a plain .in()
  // is capped at 1000 rows by PostgREST, and with raw + graded rows per card
  // that ceiling is hit quickly — silently dropping most cards' prices and
  // making the whole screen look empty. We also do NOT hard-filter on
  // expires_at: a price-sync lag would otherwise exclude EVERY price and leave
  // the screen useless. market_prices is upserted in place, so each row already
  // holds the latest price — stale-but-present beats missing for arbitrage.
  const allPrices = await fetchAllByIn<{
    card_id: string;
    source: string;
    grade: string | null;
    market_price: number | null;
    source_product_id: string | null;
  }>({
    table: "market_prices",
    columns: "card_id, source, grade, market_price, source_product_id",
    column: "card_id",
    ids: cardIds,
  });

  // Group prices by card ID
  const pricesByCard = new Map<string, typeof allPrices>();
  for (const price of allPrices ?? []) {
    if (!pricesByCard.has(price.card_id)) pricesByCard.set(price.card_id, []);
    pricesByCard.get(price.card_id)!.push(price);
  }

  const opportunities: ArbitrageOpportunity[] = [];

  for (const item of inventory) {
    const card = item.cards as any;
    const set = card?.sets as any;
    const cardId = item.card_id as string;
    const prices = pricesByCard.get(cardId) ?? [];

    // Raw price — prefer TCGPlayer, fallback to CardMarket
    const rawRow =
      prices.find(
        (p) => !p.grade && p.source === "tcgplayer" && p.market_price,
      ) ?? prices.find((p) => !p.grade && p.market_price);
    const rawPrice = rawRow?.market_price ?? null;

    // All graded prices — see filterGradePricesForCard above for the
    // source-gating rule (CLAUDE.md §6).
    const gradePrices: GradePrice[] = filterGradePricesForCard(prices, useNewPrecedence);

    // Find best graded price for target grade
    const targetGradePrice =
      gradePrices.find(
        (g) =>
          g.company.toUpperCase() === gradingService.toUpperCase() &&
          g.grade === targetGrade,
      ) ??
      gradePrices[0] ??
      null; // fallback to highest graded price available

    // Calculate ROI
    let bestProfit: number | null = null;
    let bestROI: number | null = null;

    if (targetGradePrice && rawPrice !== null) {
      bestProfit = targetGradePrice.price - rawPrice - gradingCost;
      bestROI = (bestProfit / (rawPrice + gradingCost)) * 100;
    } else if (targetGradePrice && item.purchase_price) {
      // Use purchase price as fallback cost basis
      bestProfit = targetGradePrice.price - item.purchase_price - gradingCost;
      bestROI = (bestProfit / (item.purchase_price + gradingCost)) * 100;
    }

    opportunities.push({
      inventoryId: item.id,
      cardId,
      cardName: card?.name ?? "Unknown",
      cardNumber: card?.number ?? "",
      setName: set?.name ?? "",
      setId: card?.set_id ?? "",
      imageSmall: card?.image_small ?? null,
      rarity: card?.rarity ?? null,
      rawPrice,
      purchasePrice: item.purchase_price ?? null,
      gradePrices,
      bestGrade: targetGradePrice,
      bestProfit,
      bestROI,
      gradingCostUsed: gradingCost,
      recommendation: classify(bestROI),
    });
  }

  // Sort by ROI descending
  opportunities.sort((a, b) => (b.bestROI ?? -999) - (a.bestROI ?? -999));

  const cardsWithData = opportunities.filter((o) => o.bestROI !== null).length;

  return {
    totalRawCards: inventory.length,
    cardsWithData,
    strongBuy: opportunities.filter((o) => o.recommendation === "strong_buy")
      .length,
    buy: opportunities.filter((o) => o.recommendation === "buy").length,
    marginal: opportunities.filter((o) => o.recommendation === "marginal")
      .length,
    hold: opportunities.filter((o) => o.recommendation === "hold").length,
    topOpportunities: opportunities
      .filter((o) => o.bestROI !== null)
      .slice(0, 10),
    allOpportunities: opportunities,
  };
};

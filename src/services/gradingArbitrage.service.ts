// src/services/gradingArbitrage.service.ts
// Calculates grading ROI for raw cards in a user's inventory.
// For each raw card: fetches raw price + graded prices (PSA/BGS/CGC),
// computes profit and ROI after grading costs, ranks by opportunity.

import { supabaseAdmin } from '../lib/supabase';

// ─── Grading costs (USD) ──────────────────────────────────────────────────────
// Standard tier pricing as of 2025. These are approximate — user can override.

export const GRADING_COSTS: Record<string, Record<string, number>> = {
  PSA: {
    value:      25,   // Value (cards declared ≤$499)
    regular:    50,   // Regular (≤$999)
    express:   150,   // Express
    walkthrough: 600, // Walkthrough (same day)
  },
  BGS: {
    economy:    22,
    standard:   35,
    express:    80,
    premium:   200,
  },
  CGC: {
    economy:    20,
    standard:   30,
    express:    60,
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface GradePrice {
  company: string;   // PSA | BGS | CGC | EBAY
  grade: string;     // 10 | 9 | 9.5 etc
  price: number;
  source: string;    // cardmarket | ebay
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
  bestProfit: number | null;        // after grading cost
  bestROI: number | null;           // percentage
  gradingCostUsed: number;
  recommendation: 'strong_buy' | 'buy' | 'marginal' | 'hold' | 'no_data';
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

const classify = (roi: number | null): ArbitrageOpportunity['recommendation'] => {
  if (roi === null) return 'no_data';
  if (roi >= 300) return 'strong_buy';
  if (roi >= 100) return 'buy';
  if (roi >= 30)  return 'marginal';
  return 'hold';
};

// ─── Main service ─────────────────────────────────────────────────────────────

export const getGradingArbitrage = async (
  userId: string,
  gradingService: string = 'PSA',
  gradingTier: string = 'value',
  targetGrade: string = '10',
): Promise<ArbitrageSummary> => {

  const gradingCost = GRADING_COSTS[gradingService]?.[gradingTier] ?? 25;

  // Get all raw cards from user's inventory
  const { data: inventory } = await supabaseAdmin
    .from('inventory')
    .select(`
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
    `)
    .eq('user_id', userId)
    .eq('item_type', 'raw_card')
    .not('card_id', 'is', null);

  if (!inventory?.length) {
    return {
      totalRawCards: 0, cardsWithData: 0,
      strongBuy: 0, buy: 0, marginal: 0, hold: 0,
      topOpportunities: [], allOpportunities: [],
    };
  }

  const cardIds = [...new Set(inventory.map((i) => i.card_id as string))];

  // Fetch all prices for these cards in one query
  const { data: allPrices } = await supabaseAdmin
    .from('market_prices')
    .select('card_id, source, grade, market_price')
    .in('card_id', cardIds)
    .gt('expires_at', new Date().toISOString());

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
    const rawRow = prices.find((p) => !p.grade && p.source === 'tcgplayer' && p.market_price)
      ?? prices.find((p) => !p.grade && p.market_price);
    const rawPrice = rawRow?.market_price ?? null;

    // All graded prices
    const gradePrices: GradePrice[] = prices
      .filter((p) => p.grade && p.market_price)
      .map((p) => {
        const parts = p.grade!.split(' ');
        return {
          company: parts[0] ?? 'UNKNOWN',
          grade: parts[1] ?? p.grade!,
          price: p.market_price!,
          source: p.source,
        };
      })
      .sort((a, b) => b.price - a.price);

    // Find best graded price for target grade
    const targetGradePrice = gradePrices.find(
      (g) =>
        g.company.toUpperCase() === gradingService.toUpperCase() &&
        g.grade === targetGrade
    ) ?? gradePrices[0] ?? null; // fallback to highest graded price available

    // Calculate ROI
    let bestProfit: number | null = null;
    let bestROI: number | null = null;

    if (targetGradePrice && rawPrice !== null) {
      bestProfit = targetGradePrice.price - rawPrice - gradingCost;
      bestROI = ((bestProfit) / (rawPrice + gradingCost)) * 100;
    } else if (targetGradePrice && item.purchase_price) {
      // Use purchase price as fallback cost basis
      bestProfit = targetGradePrice.price - item.purchase_price - gradingCost;
      bestROI = ((bestProfit) / (item.purchase_price + gradingCost)) * 100;
    }

    opportunities.push({
      inventoryId: item.id,
      cardId,
      cardName: card?.name ?? 'Unknown',
      cardNumber: card?.number ?? '',
      setName: set?.name ?? '',
      setId: card?.set_id ?? '',
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
    strongBuy: opportunities.filter((o) => o.recommendation === 'strong_buy').length,
    buy: opportunities.filter((o) => o.recommendation === 'buy').length,
    marginal: opportunities.filter((o) => o.recommendation === 'marginal').length,
    hold: opportunities.filter((o) => o.recommendation === 'hold').length,
    topOpportunities: opportunities.filter((o) => o.bestROI !== null).slice(0, 10),
    allOpportunities: opportunities,
  };
};
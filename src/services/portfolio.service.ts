import {
  findSnapshotsByUser,
  upsertSnapshot,
  findAllUsersWithInventory,
} from "../repositories/portfolio.repository";
import { getInventory } from "./inventory.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioData {
  // Current state
  currentValue: number;
  costBasis: number;
  gainLoss: number;
  gainLossPct: number | null;

  // Breakdown by type
  breakdown: {
    rawCards: { value: number; count: number };
    gradedCards: { value: number; count: number };
    sealedProducts: { value: number; count: number };
  };

  // Historical chart data
  history: {
    date: string;
    totalValue: number;
    costBasis: number;
    gainLoss: number;
    rawCardValue: number;
    gradedCardValue: number;
    sealedProductValue: number;
  }[];

  // Performance metrics
  allTimeHigh: number;
  allTimeLow: number;
  changeToday: number | null;
  changeTodayPct: number | null;
  change7d: number | null;
  change7dPct: number | null;
  change30d: number | null;
  change30dPct: number | null;

  // Top performers
  topGainers: TopPerformer[];
  topLosers: TopPerformer[];

  // Meta
  totalItems: number;
  lastSnapshotDate: string | null;
  hasHistory: boolean;
}

export interface TopPerformer {
  id: string;
  name: string;
  setName: string;
  imageUrl: string | null;
  itemType: string;
  gradingCompany: string | null;
  grade: string | null;
  purchasePrice: number | null;
  marketPrice: number | null;
  gainLoss: number | null;
  gainLossPct: number | null;
}

// ─── Snapshot creation ────────────────────────────────────────────────────────

export const createSnapshotForUser = async (userId: string): Promise<void> => {
  try {
    const { items, summary } = await getInventory(userId);

    // Calculate value per type
    let rawCardValue = 0;
    let gradedCardValue = 0;
    let sealedProductValue = 0;

    for (const item of items) {
      const v = item.marketValue.marketPrice ?? 0;
      if (item.item_type === "raw_card") rawCardValue += v;
      else if (item.item_type === "graded_card") gradedCardValue += v;
      else if (item.item_type === "sealed_product") sealedProductValue += v;
    }

    await upsertSnapshot({
      userId,
      snapshotDate: new Date().toISOString().split("T")[0],
      totalValue: summary.totalMarketValue,
      totalCostBasis: summary.totalCostBasis,
      totalGainLoss: summary.totalGainLoss,
      rawCardValue,
      gradedCardValue,
      sealedProductValue,
      totalItems: summary.totalItems,
      rawCards: summary.rawCards,
      gradedCards: summary.gradedCards,
      sealedProducts: summary.sealedProducts,
    });

    console.log(
      `[Portfolio] Snapshot created for user ${userId}: $${summary.totalMarketValue.toFixed(2)}`,
    );
  } catch (err: any) {
    console.error(
      `[Portfolio] Snapshot failed for user ${userId}:`,
      err?.message,
    );
    throw err;
  }
};

// ─── Full portfolio sync — called by cron ─────────────────────────────────────

export const syncAllPortfolios = async (): Promise<{
  total: number;
  succeeded: number;
  failed: number;
}> => {
  console.log("[Portfolio] Starting daily snapshot sync...");

  const userIds = await findAllUsersWithInventory();
  console.log(`[Portfolio] Snapshotting ${userIds.length} users...`);

  let succeeded = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      await createSnapshotForUser(userId);
      succeeded++;
    } catch {
      failed++;
    }
    // Small delay to avoid hammering the DB
    await new Promise((res) => setTimeout(res, 200));
  }

  console.log(
    `[Portfolio] Sync complete. Succeeded: ${succeeded}, Failed: ${failed}`,
  );
  return { total: userIds.length, succeeded, failed };
};

// ─── Portfolio analytics for a single user ────────────────────────────────────

export const getPortfolio = async (
  userId: string,
  days = 90,
): Promise<PortfolioData> => {
  // Run inventory fetch and history fetch in parallel
  const [inventoryData, snapshots] = await Promise.all([
    getInventory(userId),
    findSnapshotsByUser(userId, days),
  ]);

  const { items, summary } = inventoryData;

  // Today's snapshot may not exist yet — use live inventory data as current
  const currentValue = summary.totalMarketValue;
  const costBasis = summary.totalCostBasis;
  const gainLoss = summary.totalGainLoss;
  const gainLossPct = costBasis > 0 ? (gainLoss / costBasis) * 100 : null;

  // Breakdown by type (live)
  let rawCardValue = 0;
  let gradedCardValue = 0;
  let sealedProductValue = 0;

  for (const item of items) {
    const v = item.marketValue.marketPrice ?? 0;
    if (item.item_type === "raw_card") rawCardValue += v;
    else if (item.item_type === "graded_card") gradedCardValue += v;
    else if (item.item_type === "sealed_product") sealedProductValue += v;
  }

  // Build history array from snapshots
  // Inject today's live value as the last point
  const today = new Date().toISOString().split("T")[0];
  const historyFromSnapshots = snapshots.map((s) => ({
    date: s.snapshotDate,
    totalValue: s.totalValue,
    costBasis: s.totalCostBasis,
    gainLoss: s.totalGainLoss,
    rawCardValue: s.rawCardValue,
    gradedCardValue: s.gradedCardValue,
    sealedProductValue: s.sealedProductValue,
  }));

  // Replace or append today's live data
  const hasToday = historyFromSnapshots.some((h) => h.date === today);
  if (!hasToday && currentValue > 0) {
    historyFromSnapshots.push({
      date: today,
      totalValue: currentValue,
      costBasis,
      gainLoss,
      rawCardValue,
      gradedCardValue,
      sealedProductValue,
    });
  }

  // Performance metrics
  const allValues = historyFromSnapshots.map((h) => h.totalValue);
  const allTimeHigh =
    allValues.length > 0 ? Math.max(...allValues) : currentValue;
  const allTimeLow =
    allValues.length > 0 ? Math.min(...allValues) : currentValue;

  const findValueDaysAgo = (d: number): number | null => {
    const target = new Date();
    target.setDate(target.getDate() - d);
    const targetDate = target.toISOString().split("T")[0];
    // Find closest snapshot at or before that date
    const candidates = historyFromSnapshots.filter((h) => h.date <= targetDate);
    if (!candidates.length) return null;
    return candidates[candidates.length - 1].totalValue;
  };

  const prev1d = findValueDaysAgo(1);
  const prev7d = findValueDaysAgo(7);
  const prev30d = findValueDaysAgo(30);

  const calcChange = (prev: number | null) => {
    if (prev === null) return { change: null, pct: null };
    const change = currentValue - prev;
    const pct = prev > 0 ? (change / prev) * 100 : null;
    return { change, pct };
  };

  const { change: changeToday, pct: changeTodayPct } = calcChange(prev1d);
  const { change: change7d, pct: change7dPct } = calcChange(prev7d);
  const { change: change30d, pct: change30dPct } = calcChange(prev30d);

  // Top performers — items with purchase price and market price
  const itemsWithGainLoss = items
    .filter((item) => item.gainLoss !== null && item.purchase_price !== null)
    .map(
      (item): TopPerformer => ({
        id: item.id,
        name: item.card?.name ?? item.product?.name ?? "Unknown",
        setName: item.card?.sets?.name ?? item.product?.set_id ?? "",
        imageUrl: item.card?.image_small ?? item.product?.image_url ?? null,
        itemType: item.item_type,
        gradingCompany: item.grading_company,
        grade: item.grade,
        purchasePrice: item.purchase_price,
        marketPrice: item.marketValue.marketPrice,
        gainLoss: item.gainLoss,
        gainLossPct: item.gainLossPct,
      }),
    );

  const topGainers = [...itemsWithGainLoss]
    .filter((i) => (i.gainLoss ?? 0) > 0)
    .sort((a, b) => (b.gainLossPct ?? 0) - (a.gainLossPct ?? 0))
    .slice(0, 5);

  const topLosers = [...itemsWithGainLoss]
    .filter((i) => (i.gainLoss ?? 0) < 0)
    .sort((a, b) => (a.gainLossPct ?? 0) - (b.gainLossPct ?? 0))
    .slice(0, 5);

  const latestSnapshot =
    snapshots.length > 0 ? snapshots[snapshots.length - 1] : null;

  return {
    currentValue,
    costBasis,
    gainLoss,
    gainLossPct,
    breakdown: {
      rawCards: { value: rawCardValue, count: summary.rawCards },
      gradedCards: { value: gradedCardValue, count: summary.gradedCards },
      sealedProducts: {
        value: sealedProductValue,
        count: summary.sealedProducts,
      },
    },
    history: historyFromSnapshots,
    allTimeHigh,
    allTimeLow,
    changeToday,
    changeTodayPct,
    change7d,
    change7dPct,
    change30d,
    change30dPct,
    topGainers,
    topLosers,
    totalItems: summary.totalItems,
    lastSnapshotDate: latestSnapshot?.snapshotDate ?? null,
    hasHistory: snapshots.length > 1,
  };
};

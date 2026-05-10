// src/services/adminAnalytics.service.ts
// Admin-only analytics — user stats and Pokémon collection stats

import { supabaseAdmin } from '../lib/supabase';

// ─── User analytics ───────────────────────────────────────────────────────────

export const getUserStats = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Total users
  const { count: totalUsers } = await supabaseAdmin
    .from('profiles')
    .select('*', { count: 'exact', head: true });

  // New users last 30 days
  const { count: newLast30 } = await supabaseAdmin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', thirtyDaysAgo);

  // New users last 7 days
  const { count: newLast7 } = await supabaseAdmin
    .from('profiles')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', sevenDaysAgo);

  // Subscriptions by plan and status
  const { data: subs } = await supabaseAdmin
    .from('subscriptions')
    .select('plan, status');

  const activeSubs = (subs ?? []).filter((s) => ['active', 'trialing'].includes(s.status));
  const byPlan = {
    collector: activeSubs.filter((s) => s.plan === 'collector').length,
    pro: activeSubs.filter((s) => s.plan === 'pro').length,
    trialing: (subs ?? []).filter((s) => s.status === 'trialing').length,
    canceled: (subs ?? []).filter((s) => s.status === 'canceled').length,
    past_due: (subs ?? []).filter((s) => s.status === 'past_due').length,
  };

  const free = (totalUsers ?? 0) - activeSubs.length;

  return {
    totalUsers: totalUsers ?? 0,
    newLast30Days: newLast30 ?? 0,
    newLast7Days: newLast7 ?? 0,
    subscriptions: {
      free,
      collector: byPlan.collector,
      pro: byPlan.pro,
      trialing: byPlan.trialing,
      canceled: byPlan.canceled,
      pastDue: byPlan.past_due,
      totalPaid: byPlan.collector + byPlan.pro,
      conversionRate: totalUsers ? Math.round(((byPlan.collector + byPlan.pro) / (totalUsers ?? 1)) * 100) : 0,
    },
  };
};

// ─── Pokémon collection analytics ────────────────────────────────────────────

export const getCollectionStats = async () => {
  // Total inventory items
  const { count: totalInventory } = await supabaseAdmin
    .from('inventory')
    .select('*', { count: 'exact', head: true });

  // By item type
  const { data: byType } = await supabaseAdmin
    .from('inventory')
    .select('item_type');

  const typeBreakdown = {
    raw_card: (byType ?? []).filter((i) => i.item_type === 'raw_card').length,
    graded_card: (byType ?? []).filter((i) => i.item_type === 'graded_card').length,
    sealed_product: (byType ?? []).filter((i) => i.item_type === 'sealed_product').length,
  };

  // Unique users with inventory
  const { data: usersWithInv } = await supabaseAdmin
    .from('inventory')
    .select('user_id')
    .limit(10000);
  const uniqueInvUsers = new Set((usersWithInv ?? []).map((i) => i.user_id)).size;

  // Average inventory size per user
  const avgInventorySize = uniqueInvUsers > 0
    ? Math.round((totalInventory ?? 0) / uniqueInvUsers)
    : 0;

  // Master set tracking
  const { count: totalTrackedSets } = await supabaseAdmin
    .from('master_set_tracking')
    .select('*', { count: 'exact', head: true });

  const { data: trackedByUser } = await supabaseAdmin
    .from('master_set_tracking')
    .select('user_id');
  const usersTrackingSets = new Set((trackedByUser ?? []).map((t) => t.user_id)).size;

  // Most tracked sets
  const { data: setTracking } = await supabaseAdmin
    .from('master_set_tracking')
    .select('set_id');

  const setCountMap = new Map<string, number>();
  for (const t of setTracking ?? []) {
    setCountMap.set(t.set_id, (setCountMap.get(t.set_id) ?? 0) + 1);
  }
  const mostTrackedSets = [...setCountMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([setId, count]) => ({ setId, count }));

  // Portfolio snapshots
  const { count: totalSnapshots } = await supabaseAdmin
    .from('portfolio_snapshots')
    .select('*', { count: 'exact', head: true });

  // Latest portfolio values
  const { data: latestSnaps } = await supabaseAdmin
    .from('portfolio_snapshots')
    .select('user_id, total_value')
    .order('snapshot_date', { ascending: false })
    .limit(1000);

  const uniqueSnapUsers = new Map<string, number>();
  for (const s of latestSnaps ?? []) {
    if (!uniqueSnapUsers.has(s.user_id)) {
      uniqueSnapUsers.set(s.user_id, s.total_value ?? 0);
    }
  }

  const portfolioValues = [...uniqueSnapUsers.values()];
  const avgPortfolioValue = portfolioValues.length > 0
    ? Math.round(portfolioValues.reduce((a, b) => a + b, 0) / portfolioValues.length)
    : 0;
  const totalPortfolioValue = portfolioValues.reduce((a, b) => a + b, 0);

  // Centering reports
  const { count: totalCenteringReports } = await supabaseAdmin
    .from('centering_reports')
    .select('*', { count: 'exact', head: true });

  // Cards and sets in DB
  const { count: totalCards } = await supabaseAdmin
    .from('cards')
    .select('*', { count: 'exact', head: true });

  const { count: totalSets } = await supabaseAdmin
    .from('sets')
    .select('*', { count: 'exact', head: true });

  // Price coverage
  const { count: cardsWithPrices } = await supabaseAdmin
    .from('market_prices')
    .select('card_id', { count: 'exact', head: true })
    .is('grade', null);

  return {
    inventory: {
      totalItems: totalInventory ?? 0,
      byType: typeBreakdown,
      uniqueUsers: uniqueInvUsers,
      avgSizePerUser: avgInventorySize,
    },
    masterSets: {
      totalTrackedSets: totalTrackedSets ?? 0,
      usersTrackingSets,
      avgSetsPerUser: usersTrackingSets > 0
        ? Math.round((totalTrackedSets ?? 0) / usersTrackingSets * 10) / 10
        : 0,
      mostTracked: mostTrackedSets,
    },
    portfolio: {
      totalSnapshots: totalSnapshots ?? 0,
      usersWithPortfolio: uniqueSnapUsers.size,
      avgPortfolioValue,
      totalPortfolioValue: Math.round(totalPortfolioValue),
    },
    centering: {
      totalReports: totalCenteringReports ?? 0,
    },
    database: {
      totalCards: totalCards ?? 0,
      totalSets: totalSets ?? 0,
      cardsWithPrices: cardsWithPrices ?? 0,
      priceCoveragePct: totalCards
        ? Math.round(((cardsWithPrices ?? 0) / totalCards) * 100)
        : 0,
    },
  };
};

// ─── Set-specific analytics ───────────────────────────────────────────────────

export const getSetAnalytics = async (limit = 20) => {
  // Most collected sets (by inventory count)
  const { data: invItems } = await supabaseAdmin
    .from('inventory')
    .select('card_id, cards!inner(set_id)')
    .eq('item_type', 'raw_card')
    .limit(50000);

  const setMap = new Map<string, number>();
  for (const item of invItems ?? []) {
    const setId = (item.cards as any)?.set_id;
    if (setId) setMap.set(setId, (setMap.get(setId) ?? 0) + 1);
  }

  const topSets = [...setMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([setId, count]) => ({ setId, inventoryCount: count }));

  return { topCollectedSets: topSets };
};

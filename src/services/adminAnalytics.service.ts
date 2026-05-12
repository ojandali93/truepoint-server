// src/services/adminAnalytics.service.ts
// Admin-only analytics — rewritten to use count queries instead of
// fetching full table rows into memory (which caused timeouts).

import { supabaseAdmin } from "../lib/supabase";

// ─── User analytics ───────────────────────────────────────────────────────────

export const getUserStats = async () => {
  const now = new Date();
  const thirtyDaysAgo = new Date(
    now.getTime() - 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const sevenDaysAgo = new Date(
    now.getTime() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [
    { count: totalUsers },
    { count: newLast30 },
    { count: newLast7 },
    { data: subs },
  ] = await Promise.all([
    supabaseAdmin.from("profiles").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("created_at", thirtyDaysAgo),
    supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .gte("created_at", sevenDaysAgo),
    supabaseAdmin.from("subscriptions").select("plan, status"),
  ]);

  const allSubs = subs ?? [];
  const activeSubs = allSubs.filter((s) =>
    ["active", "trialing"].includes(s.status),
  );

  const byPlan = {
    collector: activeSubs.filter((s) => s.plan === "collector").length,
    pro: activeSubs.filter((s) => s.plan === "pro").length,
    trialing: allSubs.filter((s) => s.status === "trialing").length,
    canceled: allSubs.filter((s) => s.status === "canceled").length,
    past_due: allSubs.filter((s) => s.status === "past_due").length,
  };

  const free = (totalUsers ?? 0) - activeSubs.length;
  const total = totalUsers ?? 0;

  return {
    totalUsers: total,
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
      conversionRate:
        total > 0
          ? Math.round(((byPlan.collector + byPlan.pro) / total) * 100)
          : 0,
    },
  };
};

// ─── Collection analytics ─────────────────────────────────────────────────────

export const getCollectionStats = async () => {
  // All count queries run in parallel — no full table scans
  const [
    { count: totalInventory },
    { count: rawCards },
    { count: gradedCards },
    { count: sealedProducts },
    { count: totalTrackedSets },
    { count: totalSnapshots },
    { count: totalCenteringReports },
    { count: totalCards },
    { count: totalSets },
    { count: cardsWithPrices },
  ] = await Promise.all([
    supabaseAdmin
      .from("inventory")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("inventory")
      .select("id", { count: "exact", head: true })
      .eq("item_type", "raw_card"),
    supabaseAdmin
      .from("inventory")
      .select("id", { count: "exact", head: true })
      .eq("item_type", "graded_card"),
    supabaseAdmin
      .from("inventory")
      .select("id", { count: "exact", head: true })
      .eq("item_type", "sealed_product"),
    supabaseAdmin
      .from("master_set_tracking")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("portfolio_snapshots")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("centering_reports")
      .select("id", { count: "exact", head: true }),
    supabaseAdmin.from("cards").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("sets").select("id", { count: "exact", head: true }),
    supabaseAdmin
      .from("market_prices")
      .select("card_id", { count: "exact", head: true })
      .is("grade", null),
  ]);

  // Unique users with inventory
  const { data: invUsers } = await supabaseAdmin
    .from("inventory")
    .select("user_id")
    .limit(5000);
  const uniqueInvUsers = new Set((invUsers ?? []).map((i) => i.user_id)).size;

  // Unique users tracking sets + most tracked sets
  const { data: trackingRows } = await supabaseAdmin
    .from("master_set_tracking")
    .select("user_id, set_id")
    .limit(5000);
  const usersTrackingSets = new Set((trackingRows ?? []).map((t) => t.user_id))
    .size;

  const setCountMap = new Map<string, number>();
  for (const t of trackingRows ?? []) {
    setCountMap.set(t.set_id, (setCountMap.get(t.set_id) ?? 0) + 1);
  }
  const mostTrackedSets = [...setCountMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([setId, count]) => ({ setId, count }));

  // Portfolio values — most recent snapshot per user
  const { data: latestSnaps } = await supabaseAdmin
    .from("portfolio_snapshots")
    .select("user_id, total_value")
    .order("snapshot_date", { ascending: false })
    .limit(500);

  const uniqueSnapUsers = new Map<string, number>();
  for (const s of latestSnaps ?? []) {
    if (!uniqueSnapUsers.has(s.user_id)) {
      uniqueSnapUsers.set(s.user_id, s.total_value ?? 0);
    }
  }
  const portfolioValues = [...uniqueSnapUsers.values()];
  const totalPortfolioVal = portfolioValues.reduce((a, b) => a + b, 0);

  const tc = totalCards ?? 0;
  const cp = cardsWithPrices ?? 0;

  return {
    inventory: {
      totalItems: totalInventory ?? 0,
      byType: {
        raw_card: rawCards ?? 0,
        graded_card: gradedCards ?? 0,
        sealed_product: sealedProducts ?? 0,
      },
      uniqueUsers: uniqueInvUsers,
      avgSizePerUser:
        uniqueInvUsers > 0
          ? Math.round((totalInventory ?? 0) / uniqueInvUsers)
          : 0,
    },
    masterSets: {
      totalTrackedSets: totalTrackedSets ?? 0,
      usersTrackingSets,
      avgSetsPerUser:
        usersTrackingSets > 0
          ? Math.round(((totalTrackedSets ?? 0) / usersTrackingSets) * 10) / 10
          : 0,
      mostTracked: mostTrackedSets,
    },
    portfolio: {
      totalSnapshots: totalSnapshots ?? 0,
      usersWithPortfolio: uniqueSnapUsers.size,
      avgPortfolioValue:
        portfolioValues.length > 0
          ? Math.round(totalPortfolioVal / portfolioValues.length)
          : 0,
      totalPortfolioValue: Math.round(totalPortfolioVal),
    },
    centering: {
      totalReports: totalCenteringReports ?? 0,
    },
    database: {
      totalCards: tc,
      totalSets: totalSets ?? 0,
      cardsWithPrices: cp,
      priceCoveragePct: tc > 0 ? Math.round((cp / tc) * 100) : 0,
    },
  };
};

// ─── Set analytics ────────────────────────────────────────────────────────────

export const getSetAnalytics = async (limit = 20) => {
  const { data: invItems } = await supabaseAdmin
    .from("inventory")
    .select("card_id, cards!inner(set_id)")
    .eq("item_type", "raw_card")
    .limit(10000);

  const setMap = new Map<string, number>();
  for (const item of invItems ?? []) {
    const setId = (item.cards as any)?.set_id;
    if (setId) setMap.set(setId, (setMap.get(setId) ?? 0) + 1);
  }

  const topSets = [...setMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([setId, inventoryCount]) => ({ setId, inventoryCount }));

  return { topCollectedSets: topSets };
};

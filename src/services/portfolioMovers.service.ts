// src/services/portfolioMovers.service.ts
//
// Portfolio change attribution ("what moved my portfolio") for a window
// (1d/7d/30d): separates market-price movement from inventory adds/removals,
// excludes-and-discloses holdings with missing/stale price data, and closes
// a reconciliation identity that the client can verify without re-deriving
// server math.
//
// v1 is a disclosed APPROXIMATION, not a ledger-backed exact reconstruction
// (see inventory_events, a separate follow-up — not read here). Two gaps are
// structural, not bugs:
//   - Hard-deleted inventory rows (deleteInventoryItem does a real SQL
//     DELETE, no tombstone) are invisible to this service — it can only see
//     what's currently active or currently status='sold'. A hard delete
//     during the window is silently absent from BOTH the current side and
//     the reconstructed-start side of the identity, so it does not cause a
//     divergence between them — it just means reconstructedStartValue
//     understates the true historical total by whatever that item was
//     worth. This is the "approximation" decision #1 accepted for v1.
//   - status='traded' rows (see trades.service.ts) are likewise not read
//     here — they behave like a hard delete from this service's point of
//     view (preserved in the DB, but this service only ever queries
//     status='active' and status='sold'). Flagged, not fixed, in v1.
//
// The reconciliation identity is engineered to close EXACTLY (to the cent)
// among everything this service CAN see, independent of those two gaps —
// see "the flat rule" below.

import {
  getInventory,
  InventoryItemWithValue,
} from "./inventory.service";
import {
  findSoldByUserInWindow,
  InventoryRow,
} from "../repositories/inventory.repository";
import {
  fetchHistoricalPriceRows,
  HistoricalPriceRow,
} from "../repositories/portfolioMovers.repository";
import { variantKey } from "../lib/variantKey";
import { matchVariantPrice } from "../lib/variantMatch";
import { requireFeature } from "./plan.service";

// ─── Types (mirrored 1:1 by mobile's src/types/movers.ts) ─────────────────────

export type MoversWindow = "1d" | "7d" | "30d";

export type ExcludedReason =
  | "no_history" // has a current price, no resolvable historical price
  | "no_current_price" // has (or had) a historical price, no current price
  | "no_price_data" // neither resolves
  | "sealed_product_unsupported"; // no local history table for products at all

export interface MoverEntry {
  inventoryId: string;
  cardId: string | null;
  productId: string | null;
  name: string;
  imageUrl: string | null;
  itemType: InventoryRow["item_type"];
  variantType: string | null;
  gradingCompany: string | null;
  grade: string | null;
  quantity: number;
  priceThen: number;
  priceNow: number;
  contribution: number; // (priceNow - priceThen) * quantity
  contributionPct: number | null; // vs priceThen * quantity
  contributionApproximate: boolean; // updated_at fell inside the window —
  // possible untracked quantity/detail change (decision #2 heuristic; v1 has
  // no ledger to know for sure, so this is disclosed, never silent).
}

export interface AdditionEntry {
  inventoryId: string;
  cardId: string | null;
  productId: string | null;
  name: string;
  addedAt: string;
  quantity: number;
  currentValue: number; // priceNow * quantity — full value counted as an addition
}

export interface RemovalEntry {
  inventoryId: string;
  cardId: string | null;
  productId: string | null;
  name: string;
  soldAt: string;
  quantity: number;
  soldPrice: number; // realized — what the user actually entered. DISPLAY ONLY.
  marketValueUsed: number; // per-unit price actually used in identity math
  marketValueSource: "window_start" | "at_sale_fallback";
  vsMarket: number; // soldPrice - (marketValueUsed * quantity) — informational
  // only. Correction 1: realized and market values can't mix in a
  // market-value identity, so this NEVER feeds inventoryDelta/removals.total.
}

export interface ExcludedEntry {
  inventoryId: string;
  cardId: string | null;
  productId: string | null;
  name: string;
  reason: ExcludedReason;
  lastKnownValue: number; // disclosure only — see "the flat rule" comment
  // below for why this is NOT summed into the identity.
}

export interface MoversIdentity {
  namedMoversTotal: number;
  other: number; // marketMovement.total - namedMoversTotal. Always 0 in v1:
  // decision #5 puts EVERY attributable holding into movers[], so nothing is
  // ever held back to put here. Kept as a real, computed field (not a
  // hardcoded 0) so a future server-side "top N" split can populate it
  // without a payload shape change.
  inventoryDelta: number; // additions.total - removals.total (market value, not soldPrice)
  computedTotalDelta: number; // namedMoversTotal + other + inventoryDelta
  reportedTotalDelta: number; // currentValue - reconstructedStartValue (independent calc)
  divergence: number; // computedTotalDelta - reportedTotalDelta, cents-rounded.
  // Hard gate (Phase 2): must be 0. See "the flat rule" — excluded holdings
  // are engineered to contribute zero net to BOTH totals, so they never
  // appear as a nonzero addend here despite being real, disclosed dollars
  // in excluded.totalLastKnownValue.
}

export interface PortfolioMoversResult {
  userId: string;
  collectionId: string | null;
  window: MoversWindow;
  comparisonTimestamps: {
    asOf: string;
    requestedWindowStart: string;
    actualSnapshotDateUsed: string | null; // YYYY-MM-DD closest history date
    // actually found at-or-before window start, across all attributable
    // holdings' most common resolution — null if nothing resolved at all.
  };
  totals: {
    currentValue: number; // === getPortfolio().totalValue for this user (decision #7)
    reconstructedStartValue: number;
    delta: number;
    deltaPct: number | null;
  };
  marketMovement: {
    total: number;
    movers: MoverEntry[]; // EVERY attributable holding, sorted by |contribution| desc
  };
  additions: { total: number; entries: AdditionEntry[] };
  removals: {
    total: number; // market-value total (identity-math total, Correction 1)
    totalRealized: number; // sum of soldPrice — informational only
    entries: RemovalEntry[];
  };
  excluded: {
    count: number;
    totalLastKnownValue: number;
    entries: ExcludedEntry[];
  };
  identity: MoversIdentity;
  dataQuality: {
    hasAnyHistory: boolean;
    approximateCount: number;
    addedAndSoldCount: number; // Correction 3: added AND sold within the
    // window — appears in no bucket, contributes to no identity term.
    note: string | null;
  };
}

// ─── Constants ──────────────────────────────────────────────────────────────

const WINDOW_DAYS: Record<MoversWindow, number> = { "1d": 1, "7d": 7, "30d": 30 };

// How far before window start to look for a usable snapshot, tolerating a
// few missed cron days (snapshotCardPricesSafe runs once/day; a gap of a
// day or two is normal, not a data-quality emergency).
const HISTORY_LOOKBACK_GRACE_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

// ─── Small helpers ──────────────────────────────────────────────────────────

const toDateStr = (d: Date): string => d.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;
const toCents = (dollars: number): number => Math.round(dollars * 100);

const displayName = (item: InventoryRow): string =>
  item.card?.name ?? item.product?.name ?? "Unknown";
const displayImage = (item: InventoryRow): string | null =>
  item.card?.image_small ?? item.product?.image_url ?? null;

// ─── Historical price resolution ───────────────────────────────────────────
//
// Reuses the SAME variantKey()/matchVariantPrice() functions live pricing
// uses (inventory.service.ts / src/lib/*) rather than re-deriving the
// exact→representative-any-variant fallback strategy independently. Graded
// resolution mirrors resolveMarketValue's graded branch exactly: no
// fallback — grade-exact-or-nothing.

const groupByCard = (
  rows: HistoricalPriceRow[],
): Map<string, HistoricalPriceRow[]> => {
  const byCard = new Map<string, HistoricalPriceRow[]>();
  for (const r of rows) {
    const arr = byCard.get(r.card_id) ?? [];
    arr.push(r);
    byCard.set(r.card_id, arr);
  }
  return byCard;
};

// Closest row at-or-before targetDate among an already-filtered set (one
// card + source + variant/grade combo).
const closestAtOrBefore = (
  rows: HistoricalPriceRow[],
  targetDate: string,
): number | null => {
  let best: { date: string; price: number } | null = null;
  for (const r of rows) {
    if (r.snapshot_date <= targetDate && (!best || r.snapshot_date > best.date)) {
      best = { date: r.snapshot_date, price: Number(r.market_price) };
    }
  }
  return best?.price ?? null;
};

const resolveHistoricalRawPrice = (
  cardId: string,
  variantType: string | null | undefined,
  targetDate: string,
  rowsByCard: Map<string, HistoricalPriceRow[]>,
): number | null => {
  const rows = (rowsByCard.get(cardId) ?? []).filter(
    (r) => r.source === "tcgplayer" && r.grade === null,
  );
  if (rows.length === 0) return null;

  // Reduce the time series to ONE price per variant at targetDate, shaped
  // exactly like live pricing's { byVariant, byCard } maps, then hand off to
  // the identical matching function resolveMarketValue calls.
  const byVariant = new Map<string, HistoricalPriceRow[]>();
  for (const r of rows) {
    const k = variantKey(r.variant);
    const arr = byVariant.get(k) ?? [];
    arr.push(r);
    byVariant.set(k, arr);
  }

  const exactByKey = new Map<string, number>();
  const anyByCard = new Map<string, number>();
  for (const [vKey, vRows] of byVariant) {
    const price = closestAtOrBefore(vRows, targetDate);
    if (price == null) continue;
    exactByKey.set(`${cardId}|${vKey}`, price);
    // Representative preference mirrors fetchVariantPrices' byCard building
    // in inventory.repository.ts: prefer "normal", else first seen.
    const isNormal = vKey === "normal";
    if (isNormal || !anyByCard.has(cardId)) anyByCard.set(cardId, price);
  }

  return matchVariantPrice(exactByKey, anyByCard, cardId, variantType);
};

const resolveHistoricalGradedPrice = (
  cardId: string,
  company: string,
  grade: string,
  targetDate: string,
  rowsByCard: Map<string, HistoricalPriceRow[]>,
): number | null => {
  const gradeKey = `${company} ${grade}`;
  const rows = (rowsByCard.get(cardId) ?? []).filter(
    (r) => r.source === "poketrace" && r.grade === gradeKey,
  );
  return closestAtOrBefore(rows, targetDate);
};

// Dispatches by item type. Sealed products are never resolved here — no
// local history table exists for them (recon: historicPrices.service.ts
// notes products have no local fallback at all).
const resolveHistoricalPrice = (
  item: InventoryRow,
  targetDate: string,
  rowsByCard: Map<string, HistoricalPriceRow[]>,
): number | null => {
  if (item.item_type === "raw_card" && item.card_id) {
    return resolveHistoricalRawPrice(
      item.card_id,
      item.variant_type,
      targetDate,
      rowsByCard,
    );
  }
  if (
    item.item_type === "graded_card" &&
    item.card_id &&
    item.grading_company &&
    item.grade
  ) {
    return resolveHistoricalGradedPrice(
      item.card_id,
      item.grading_company,
      item.grade,
      targetDate,
      rowsByCard,
    );
  }
  return null;
};

// ─── The algorithm ──────────────────────────────────────────────────────────

export const getPortfolioMovers = async (
  userId: string,
  window: MoversWindow,
  collectionId: string | null = null,
  role: string | null = null,
): Promise<PortfolioMoversResult> => {
  // Same gate as getPortfolio() — portfolio_dashboard is starter-tier.
  await requireFeature(userId, "portfolio_dashboard", role);

  const now = new Date();
  const asOf = now.toISOString();
  const windowStart = new Date(now.getTime() - WINDOW_DAYS[window] * DAY_MS);
  const windowStartIso = windowStart.toISOString();
  const windowStartDate = toDateStr(windowStart);
  const todayDate = toDateStr(now);
  const lookbackStartDate = toDateStr(
    new Date(windowStart.getTime() - HISTORY_LOOKBACK_GRACE_DAYS * DAY_MS),
  );

  // 1) Active inventory + resolved current prices — the SAME function
  //    getPortfolio() calls, so totals.currentValue matches the dashboard's
  //    number by construction, not by careful reimplementation (decision #7).
  const { items: activeItems, summary } = await getInventory(
    userId,
    collectionId,
  );
  const currentValue = summary.totalMarketValue;

  // 2) Items sold within the window.
  const soldRows = await findSoldByUserInWindow(
    userId,
    windowStartIso,
    asOf,
    collectionId,
  );

  // 3) Historical prices for every card either set touches, one query.
  const cardIds = Array.from(
    new Set(
      [...activeItems, ...soldRows]
        .filter((r) => r.card_id)
        .map((r) => r.card_id as string),
    ),
  );
  const historyRows = await fetchHistoricalPriceRows(
    cardIds,
    lookbackStartDate,
    todayDate,
  );
  const rowsByCard = groupByCard(historyRows);

  const movers: MoverEntry[] = [];
  const additions: AdditionEntry[] = [];
  const excluded: ExcludedEntry[] = [];
  let reconstructedStartValue = 0;
  let approximateCount = 0;
  let addedAndSoldCount = 0;
  let anyHistoryResolved = false;
  const resolvedWindowStartDates: string[] = [];

  const excludedEntry = (
    item: InventoryRow,
    reason: ExcludedReason,
    lastKnownValue: number,
  ): ExcludedEntry => ({
    inventoryId: item.id,
    cardId: item.card_id,
    productId: item.product_id,
    name: displayName(item),
    reason,
    lastKnownValue: round2(lastKnownValue),
  });

  // ── Active holdings ──
  for (const item of activeItems as InventoryItemWithValue[]) {
    const qty = item.quantity ?? 1;
    const priceNow = item.marketValue.marketPrice;
    // Mirrors getInventory()'s own truthy guard
    // (`if (marketValue.marketPrice) totalMarketValue += ...`) exactly — a
    // resolved price of exactly $0 is treated as "no price" there, so it
    // must be treated identically here or this holding's contribution to
    // currentValue and to reconstructedStartValue would silently disagree.
    const currentContribution = priceNow ? priceNow * qty : 0;

    const addedAtMs = item.added_at ? new Date(item.added_at).getTime() : null;
    const existedAtWindowStart =
      addedAtMs != null && addedAtMs <= windowStart.getTime();

    if (!existedAtWindowStart) {
      // Added during the window.
      if (!priceNow) {
        excluded.push(excludedEntry(item, "no_current_price", 0));
        continue; // 0 on both sides — didn't exist at start, no current value either
      }
      additions.push({
        inventoryId: item.id,
        cardId: item.card_id,
        productId: item.product_id,
        name: displayName(item),
        addedAt: item.added_at,
        quantity: qty,
        currentValue: round2(priceNow * qty),
      });
      continue; // reconstruction contributes 0 — wasn't there at window start
    }

    if (item.item_type === "sealed_product") {
      // No local history table for sealed products at all (recon:
      // historicPrices.service.ts — no local fallback exists for products).
      // "The flat rule": an excluded holding's reconstruction contribution
      // is defined as EXACTLY equal to its current-value contribution, so
      // it nets to zero on the identity regardless of what that value is —
      // the real dollar figure is disclosed via lastKnownValue instead of
      // being summed into the delta.
      excluded.push(
        excludedEntry(item, "sealed_product_unsupported", currentContribution),
      );
      reconstructedStartValue += currentContribution;
      continue;
    }

    const priceThen = resolveHistoricalPrice(item, windowStartDate, rowsByCard);

    if (!priceThen && !priceNow) {
      excluded.push(excludedEntry(item, "no_price_data", 0));
      reconstructedStartValue += 0; // 0 on both sides
      continue;
    }
    if (!priceThen) {
      // no_history: has a current price, no historical one. Flat rule.
      excluded.push(excludedEntry(item, "no_history", currentContribution));
      reconstructedStartValue += currentContribution;
      continue;
    }
    if (!priceNow) {
      // no_current_price: getInventory/getPortfolio counts this at $0 today
      // (its truthy guard skips a null/0 price, not a last-known value —
      // confirmed against inventory.service.ts). Mirror that EXACTLY here:
      // currentContribution is already 0 for this holding (see above), so
      // the flat rule adds 0 to reconstruction too. lastKnownValue still
      // discloses the real historical figure for the user's benefit.
      excluded.push(
        excludedEntry(item, "no_current_price", priceThen * qty),
      );
      reconstructedStartValue += currentContribution; // === 0, per the guard above
      continue;
    }

    // Fully attributable.
    anyHistoryResolved = true;
    resolvedWindowStartDates.push(windowStartDate);
    reconstructedStartValue += priceThen * qty;
    const contribution = priceNow * qty - priceThen * qty;
    const contributionPct = priceThen > 0 ? (contribution / (priceThen * qty)) * 100 : null;
    const contributionApproximate =
      !!item.updated_at && new Date(item.updated_at).getTime() > windowStart.getTime();
    if (contributionApproximate) approximateCount++;

    movers.push({
      inventoryId: item.id,
      cardId: item.card_id,
      productId: item.product_id,
      name: displayName(item),
      imageUrl: displayImage(item),
      itemType: item.item_type,
      variantType: item.variant_type,
      gradingCompany: item.grading_company,
      grade: item.grade,
      quantity: qty,
      priceThen: round2(priceThen),
      priceNow: round2(priceNow),
      contribution: round2(contribution),
      contributionPct,
      contributionApproximate,
    });
  }

  // ── Sold items within the window ──
  const removals: RemovalEntry[] = [];
  for (const row of soldRows) {
    const qty = row.quantity ?? 1;
    if (!row.sold_at) continue; // defensive — query already filters on sold_at

    const addedAtMs = row.added_at ? new Date(row.added_at).getTime() : null;
    const existedAtWindowStart =
      addedAtMs != null && addedAtMs <= windowStart.getTime();

    if (!existedAtWindowStart) {
      // Correction 3: added AND sold within the window. Never existed at
      // window start, doesn't exist now — invisible to both totals, so it
      // contributes exactly 0 to every identity term by construction (not
      // by special-casing the math, just by never entering either sum).
      // Disclosed as an informational count only.
      addedAndSoldCount++;
      continue;
    }

    if (row.item_type === "sealed_product") {
      excluded.push(
        excludedEntry(row, "sealed_product_unsupported", row.sold_price ?? 0),
      );
      // Flat rule: this row is not in activeItems (it's sold), so it never
      // contributed to currentValue at all — 0 there, so 0 here too.
      continue;
    }

    // Correction 1: try the window-start price first; if the item has no
    // resolvable price AT window start, fall back to the closest snapshot
    // at-or-before the actual sale date rather than discarding a removal we
    // know really happened.
    let marketValueUsed = resolveHistoricalPrice(row, windowStartDate, rowsByCard);
    let marketValueSource: "window_start" | "at_sale_fallback" = "window_start";
    if (!marketValueUsed) {
      const soldAtDate = toDateStr(new Date(row.sold_at));
      marketValueUsed = resolveHistoricalPrice(row, soldAtDate, rowsByCard);
      marketValueSource = "at_sale_fallback";
    }

    if (!marketValueUsed) {
      // No price data anywhere for this removal. Flat rule again: this row
      // contributes 0 to currentValue (it's sold, not active), so it gets 0
      // in the reconstruction too — never treated as a $0 market movement,
      // just disclosed via soldPrice, the only figure we actually have.
      excluded.push(excludedEntry(row, "no_history", row.sold_price ?? 0));
      continue;
    }

    const marketValueTotal = marketValueUsed * qty;
    reconstructedStartValue += marketValueTotal;

    removals.push({
      inventoryId: row.id,
      cardId: row.card_id,
      productId: row.product_id,
      name: displayName(row),
      soldAt: row.sold_at,
      quantity: qty,
      soldPrice: row.sold_price ?? 0,
      marketValueUsed: round2(marketValueUsed),
      marketValueSource,
      // Correction 1: realized (soldPrice) vs. market (marketValueUsed)
      // values are fundamentally different quantities — one is what the
      // user actually got, the other is what the identity's market-value
      // accounting uses. Mixing them in the SAME sum would make the
      // identity meaningless (it would answer neither "how did the market
      // move" nor "how did I do selling"), so vsMarket is informational
      // only and never enters inventoryDelta or removals.total.
      vsMarket: round2((row.sold_price ?? 0) - marketValueTotal),
    });
  }

  // ── Totals & identity ──
  movers.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  const namedMoversTotal = round2(movers.reduce((s, m) => s + m.contribution, 0));
  const marketMovementTotal = namedMoversTotal;
  // Always 0 in v1 — see MoversIdentity.other's doc comment.
  const other = round2(marketMovementTotal - namedMoversTotal);

  const additionsTotal = round2(additions.reduce((s, a) => s + a.currentValue, 0));
  const removalsTotal = round2(
    removals.reduce((s, r) => s + r.marketValueUsed * r.quantity, 0),
  );
  const removalsRealizedTotal = round2(removals.reduce((s, r) => s + r.soldPrice, 0));
  const inventoryDelta = round2(additionsTotal - removalsTotal);

  const excludedTotalLastKnownValue = round2(
    excluded.reduce((s, e) => s + e.lastKnownValue, 0),
  );

  const computedTotalDelta = round2(namedMoversTotal + other + inventoryDelta);
  const reportedTotalDelta = round2(currentValue - reconstructedStartValue);
  // Integer-cents comparison so this is never a floating-point-epsilon false
  // failure (0.1 + 0.2 !== 0.3 territory) — the two totals are computed via
  // genuinely independent code paths above, so a real bug should show up as
  // a whole-cent-or-more gap, not a sub-cent one.
  const divergenceCents = toCents(computedTotalDelta) - toCents(reportedTotalDelta);
  const divergence = divergenceCents / 100;

  if (divergenceCents !== 0) {
    console.warn(
      `[PortfolioMovers] identity divergence for user ${userId} window ${window}: ` +
        `computed=${computedTotalDelta} reported=${reportedTotalDelta} divergence=${divergence}`,
    );
  }

  const deltaPct =
    reconstructedStartValue > 0
      ? round2((reportedTotalDelta / reconstructedStartValue) * 100)
      : null;

  const noteParts: string[] = [];
  if (excluded.length > 0) {
    noteParts.push(
      `${excluded.length} holding${excluded.length === 1 ? "" : "s"} excluded — missing price data ($${excludedTotalLastKnownValue.toFixed(2)} last known).`,
    );
  }
  if (removals.length > 0) {
    noteParts.push(
      "Removed items that weren't marked sold aren't tracked yet.",
    );
  }
  if (approximateCount > 0) {
    noteParts.push(
      `${approximateCount} change${approximateCount === 1 ? " is" : "s are"} approximate — quantity may have changed mid-window.`,
    );
  }
  if (addedAndSoldCount > 0) {
    noteParts.push(
      `${addedAndSoldCount} item${addedAndSoldCount === 1 ? "" : "s"} added and sold within this period.`,
    );
  }

  return {
    userId,
    collectionId: collectionId ?? null,
    window,
    comparisonTimestamps: {
      asOf,
      requestedWindowStart: windowStartIso,
      actualSnapshotDateUsed: anyHistoryResolved ? windowStartDate : null,
    },
    totals: {
      currentValue: round2(currentValue),
      reconstructedStartValue: round2(reconstructedStartValue),
      delta: reportedTotalDelta,
      deltaPct,
    },
    marketMovement: { total: marketMovementTotal, movers },
    additions: { total: additionsTotal, entries: additions },
    removals: {
      total: removalsTotal,
      totalRealized: removalsRealizedTotal,
      entries: removals,
    },
    excluded: {
      count: excluded.length,
      totalLastKnownValue: excludedTotalLastKnownValue,
      entries: excluded,
    },
    identity: {
      namedMoversTotal,
      other,
      inventoryDelta,
      computedTotalDelta,
      reportedTotalDelta,
      divergence,
    },
    dataQuality: {
      hasAnyHistory: anyHistoryResolved,
      approximateCount,
      addedAndSoldCount,
      note: noteParts.length > 0 ? noteParts.join(" ") : null,
    },
  };
};

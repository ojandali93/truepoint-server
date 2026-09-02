// affiliateCommissionAdmin.service.ts
//
// Phase 2 of AUDITS/affiliate-system-plan.md (§5) — the admin surface's
// read/write logic: per-affiliate commission summary and the "mark paid"
// action. Separate from affiliateCommission.service.ts on purpose — that
// file is webhook-facing (turns a payment event into a ledger row); this
// one is admin-facing (reads the ledger back and records payouts against
// it). Neither writes to the other's tables outside its own concern:
// this file never inserts a commission_ledger EARNING/clawback row, and
// affiliateCommission.service.ts never touches commission_payouts.

import { getById as getAffiliateById } from "./affiliate.service";
import {
  listAttributionsByAffiliateId,
  findProfileSummariesByIds,
  findLedgerRowsByAffiliateId,
  listPayoutsByAffiliateId,
  findEligibleLedgerRowsByAffiliateId,
  insertPayout,
  markLedgerRowsPaid,
  type CommissionLedgerRow,
} from "../repositories/affiliateCommission.repository";

const round2 = (n: number): number => Math.round(n * 100) / 100;

const sum = (rows: CommissionLedgerRow[], field: "net" | "commission_amount") =>
  round2(rows.reduce((acc, r) => acc + r[field], 0));

export interface ReferredUserSummary {
  user_id: string;
  username: string | null;
  full_name: string | null;
  attributed_at: string;
  converted: boolean; // window_start is set -- this user has made at least one payment
  window_start: string | null;
  window_end: string | null;
  net_contributed: number; // sum of this user's own ledger rows' net, clawbacks included
}

export interface AffiliateCommissionSummary {
  affiliate: {
    id: string;
    name: string;
    slug: string | null;
    contact_name: string | null;
    contact_email: string | null;
    status: string | null;
    active: boolean;
    commission_rate: number;
    commission_window_months: number;
  };
  referredUsers: ReferredUserSummary[];
  conversions: { referred: number; converted: number };
  ledger: CommissionLedgerRow[];
  payouts: Awaited<ReturnType<typeof listPayoutsByAffiliateId>>;
  totals: {
    attributedNetRevenue: number; // sum of ledger.net, clawbacks included -- "net is always after refunds"
    commissionEarned: number; // lifetime sum of commission_amount, clawbacks included
    commissionPaid: number; // sum where status = 'paid'
    commissionPending: number; // sum where status = 'eligible' -- not yet paid
  };
}

export async function getAffiliateCommissionSummary(
  affiliateId: string,
): Promise<AffiliateCommissionSummary> {
  const affiliate = await getAffiliateById(affiliateId);
  if (!affiliate) {
    throw Object.assign(new Error("Affiliate not found"), { status: 404 });
  }

  const [attributions, ledger, payouts] = await Promise.all([
    listAttributionsByAffiliateId(affiliateId),
    findLedgerRowsByAffiliateId(affiliateId),
    listPayoutsByAffiliateId(affiliateId),
  ]);

  const profileIds = attributions.map((a) => a.user_id);
  const profiles = await findProfileSummariesByIds(profileIds);
  const profileById = new Map(profiles.map((p) => [p.id, p]));

  const netByUser = new Map<string, number>();
  for (const row of ledger) {
    netByUser.set(row.referred_user_id, round2((netByUser.get(row.referred_user_id) ?? 0) + row.net));
  }

  const referredUsers: ReferredUserSummary[] = attributions.map((a) => {
    const p = profileById.get(a.user_id);
    return {
      user_id: a.user_id,
      username: p?.username ?? null,
      full_name: p?.full_name ?? null,
      attributed_at: a.attributed_at,
      converted: a.window_start !== null,
      window_start: a.window_start,
      window_end: a.window_end,
      net_contributed: netByUser.get(a.user_id) ?? 0,
    };
  });

  const paidRows = ledger.filter((r) => r.status === "paid");
  const eligibleRows = ledger.filter((r) => r.status === "eligible");

  return {
    affiliate: {
      id: affiliate.id,
      name: affiliate.name,
      slug: affiliate.slug ?? null,
      contact_name: affiliate.contact_name ?? null,
      contact_email: affiliate.contact_email ?? null,
      status: affiliate.status ?? null,
      active: affiliate.active,
      commission_rate: affiliate.commission_rate,
      commission_window_months: affiliate.commission_window_months,
    },
    referredUsers,
    conversions: {
      referred: attributions.length,
      converted: attributions.filter((a) => a.window_start !== null).length,
    },
    ledger,
    payouts,
    totals: {
      attributedNetRevenue: sum(ledger, "net"),
      commissionEarned: sum(ledger, "commission_amount"),
      commissionPaid: sum(paidRows, "commission_amount"),
      commissionPending: sum(eligibleRows, "commission_amount"),
    },
  };
}

export interface MarkPaidInput {
  amount: number;
  method: string;
  paidAt?: string; // defaults to now
  note?: string | null;
  markedBy: string | null; // admin's own profile id, for accountability
}

export interface MarkPaidResult {
  payout: Awaited<ReturnType<typeof insertPayout>>;
  ledgerRowsCovered: number;
  eligibleTotalAtTimeOfPayout: number;
}

/**
 * Marks ALL of an affiliate's currently-eligible commission as paid in one
 * payout record. Doc §5: manual payouts only, no partial-row selection UI
 * in v1 -- an admin paying out $50 accumulated across 3 months (the $50
 * rollover threshold, doc §1) pays the whole eligible balance at once, not
 * month by month. If a future need arises to pay out only SOME eligible
 * rows, that's a v1.1 UI change on top of this same write path (the
 * repository functions already take an explicit row-id list).
 */
export async function markAffiliatePaid(
  affiliateId: string,
  input: MarkPaidInput,
): Promise<MarkPaidResult> {
  if (!(input.amount > 0)) {
    throw Object.assign(new Error("amount must be greater than 0"), { status: 400 });
  }
  if (!input.method || !input.method.trim()) {
    throw Object.assign(new Error("method is required"), { status: 400 });
  }

  const eligibleRows = await findEligibleLedgerRowsByAffiliateId(affiliateId);
  if (eligibleRows.length === 0) {
    throw Object.assign(
      new Error("This affiliate has no eligible (unpaid) commission to mark paid"),
      { status: 400 },
    );
  }
  const eligibleTotal = sum(eligibleRows, "commission_amount");

  const payout = await insertPayout({
    affiliate_id: affiliateId,
    amount: round2(input.amount),
    method: input.method.trim(),
    paid_at: input.paidAt ?? new Date().toISOString(),
    note: input.note?.trim() || null,
    marked_by: input.markedBy,
  });

  await markLedgerRowsPaid(
    eligibleRows.map((r) => r.id),
    payout.id,
  );

  return {
    payout,
    ledgerRowsCovered: eligibleRows.length,
    eligibleTotalAtTimeOfPayout: eligibleTotal,
  };
}

// src/services/gradingLifecycle.service.ts
//
// Multi-card grading submissions (envelope model).
// One `grading_submissions` row = one envelope (e.g. "BGS submission with 13 cards").
// Each `submission_cards` row = one card inside that envelope.

import { supabaseAdmin } from "../lib/supabase";
import { GRADING_COSTS } from "./gradingArbitrage.service";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SubmissionStatus =
  | "preparing"
  | "submitted"
  | "received"
  | "grading"
  | "shipped_back"
  | "returned";

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  preparing: "Preparing",
  submitted: "Submitted",
  received: "Received by Grader",
  grading: "Being Graded",
  shipped_back: "Shipped Back",
  returned: "Returned",
};

// Advance order skips 'preparing' — a created submission starts at 'submitted'.
export const STATUS_ORDER: SubmissionStatus[] = [
  "submitted",
  "received",
  "grading",
  "shipped_back",
  "returned",
];

export interface AIReportSummary {
  id: string;
  status: string; // 'processing' | 'completed' | 'failed'
  overallScore: number | null;
  centering: number;
  corners: number;
  edges: number;
  surface: number;
  confidence: number;
  recommendation: string; // 'grade' | 'skip' | 'borderline'
  recommendationReason: string | null;
  predictions: any; // { psa, bgs, cgc, tag }
  frontImage: string | null;
  backImage: string | null;
  createdAt: string;
}

export interface SubmissionCard {
  id: string;
  submissionId: string;
  inventoryId: string | null;
  cardId: string | null;
  cardName: string;
  cardSet: string | null;
  cardNumber: string | null;
  cardImage: string | null;
  variant: string | null;
  declaredValue: number | null;
  gradingCost: number | null;
  serviceTier: string | null;
  gradeReceived: string | null;
  certNumber: string | null;
  gradedValue: number | null;
  aiGradingReportId: string | null;
  aiReport: AIReportSummary | null; // populated on detail fetch
  position: number;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GradingSubmission {
  id: string;
  userId: string;
  company: string;
  serviceTier: string | null;
  status: SubmissionStatus;
  submissionNumber: string | null;
  trackingToGrader: string | null;
  trackingFromGrader: string | null;
  declaredValueTotal: number | null;
  totalCost: number | null;
  notes: string | null;
  submittedAt: string | null;
  receivedAt: string | null;
  gradedAt: string | null;
  shippedBackAt: string | null;
  returnedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // Aggregates
  cardCount: number;
  totalGradedValue: number | null; // sum of graded_value across cards (null if none valued)
  cards?: SubmissionCard[]; // populated only on detail fetch
  daysInTransit: number;
  roi: number | null;
}

export interface CreateCardInput {
  inventoryId?: string;
  cardId?: string;
  cardName: string;
  cardSet?: string;
  cardNumber?: string;
  cardImage?: string;
  variant?: string;
  declaredValue?: number;
  notes?: string;
}

// ─── Mappers ─────────────────────────────────────────────────────────────────

const mapCard = (row: any): SubmissionCard => ({
  id: row.id,
  submissionId: row.submission_id,
  inventoryId: row.inventory_id,
  cardId: row.card_id,
  cardName: row.card_name,
  cardSet: row.card_set,
  cardNumber: row.card_number,
  cardImage: row.card_image,
  variant: row.variant,
  declaredValue: row.declared_value != null ? Number(row.declared_value) : null,
  gradingCost: row.grading_cost != null ? Number(row.grading_cost) : null,
  serviceTier: row.service_tier,
  gradeReceived: row.grade_received,
  certNumber: row.cert_number,
  gradedValue: row.graded_value != null ? Number(row.graded_value) : null,
  aiGradingReportId: row.ai_grading_report_id,
  aiReport: null, // populated later via attachAIReports()
  position: row.position ?? 0,
  notes: row.notes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

// Fetch and attach AI report summaries for a set of cards in bulk.
const attachAIReports = async (cards: SubmissionCard[]): Promise<void> => {
  const reportIds = cards
    .map((c) => c.aiGradingReportId)
    .filter((v): v is string => Boolean(v));
  if (reportIds.length === 0) return;

  const { data: reports } = await supabaseAdmin
    .from("ai_grading_reports")
    .select(
      "id, status, overall_score, centering, corners, edges, surface, confidence, recommendation, recommendation_reason, predictions, front_image, back_image, created_at",
    )
    .in("id", reportIds);

  const byId = Object.fromEntries(
    (reports ?? []).map((r: any) => [
      r.id,
      {
        id: r.id,
        status: r.status,
        overallScore: r.overall_score != null ? Number(r.overall_score) : null,
        centering: Number(r.centering) || 0,
        corners: Number(r.corners) || 0,
        edges: Number(r.edges) || 0,
        surface: Number(r.surface) || 0,
        confidence: Number(r.confidence) || 0,
        recommendation: r.recommendation,
        recommendationReason: r.recommendation_reason,
        predictions: r.predictions,
        frontImage: r.front_image,
        backImage: r.back_image,
        createdAt: r.created_at,
      } as AIReportSummary,
    ]),
  );

  cards.forEach((c) => {
    if (c.aiGradingReportId && byId[c.aiGradingReportId]) {
      c.aiReport = byId[c.aiGradingReportId];
    }
  });
};

const mapSubmission = (row: any, cardRows: any[] = []): GradingSubmission => {
  const cards = cardRows.map(mapCard);
  const submitted = row.submitted_at
    ? new Date(row.submitted_at)
    : row.created_at
      ? new Date(row.created_at)
      : new Date();
  const returned = row.returned_at ? new Date(row.returned_at) : null;
  const daysInTransit = Math.floor(
    ((returned ?? new Date()).getTime() - submitted.getTime()) / 86_400_000,
  );

  // ROI computed across returned cards only
  const returnedCards = cards.filter((c) => c.gradedValue != null);
  let roi: number | null = null;
  if (returnedCards.length > 0) {
    const value = returnedCards.reduce((s, c) => s + (c.gradedValue ?? 0), 0);
    const basis = returnedCards.reduce(
      (s, c) => s + (c.declaredValue ?? 0) + (c.gradingCost ?? 0),
      0,
    );
    roi = basis > 0 ? ((value - basis) / basis) * 100 : null;
  }

  // Sum graded values across all cards (null if none valued yet)
  const valued = cards.filter((c) => c.gradedValue != null);
  const totalGradedValue =
    valued.length > 0
      ? valued.reduce((s, c) => s + (c.gradedValue ?? 0), 0)
      : null;

  return {
    id: row.id,
    userId: row.user_id,
    company: row.company,
    serviceTier: row.service_tier,
    status: row.status,
    submissionNumber: row.submission_number,
    trackingToGrader: row.tracking_to_grader,
    trackingFromGrader: row.tracking_from_grader,
    declaredValueTotal:
      row.declared_value_total != null
        ? Number(row.declared_value_total)
        : null,
    totalCost: row.total_cost != null ? Number(row.total_cost) : null,
    notes: row.notes,
    submittedAt: row.submitted_at,
    receivedAt: row.received_at,
    gradedAt: row.graded_at,
    shippedBackAt: row.shipped_back_at,
    returnedAt: row.returned_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cardCount: cards.length,
    totalGradedValue,
    cards: cardRows.length > 0 ? cards : undefined,
    daysInTransit,
    roi,
  };
};

// ─── List submissions (envelopes only, with card count) ─────────────────────

export const getSubmissions = async (
  userId: string,
  status?: SubmissionStatus,
): Promise<GradingSubmission[]> => {
  let q = supabaseAdmin
    .from("grading_submissions")
    .select(
      "*, submission_cards(id, card_image, card_name, graded_value, declared_value, grading_cost)",
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (status) q = q.eq("status", status);

  const { data, error } = await q;
  if (error) throw error;

  return (data ?? []).map((row: any) => {
    const sub = mapSubmission(row, []);
    const childCards = row.submission_cards ?? [];
    sub.cardCount = childCards.length;

    // Total value across ALL cards in this envelope (null if none valued)
    const valued = childCards.filter((c: any) => c.graded_value != null);
    sub.totalGradedValue =
      valued.length > 0
        ? valued.reduce((s: number, c: any) => s + Number(c.graded_value), 0)
        : null;

    // Expose a small preview (first 4 card thumbnails) for the list UI
    sub.cards = childCards
      .slice(0, 4)
      .map((c: any, i: number) =>
        mapCard({ ...c, submission_id: sub.id, position: i }),
      );
    return sub;
  });
};

// ─── Get one submission with ALL cards ──────────────────────────────────────

export const getSubmission = async (
  userId: string,
  id: string,
): Promise<GradingSubmission | null> => {
  const { data, error } = await supabaseAdmin
    .from("grading_submissions")
    .select("*")
    .eq("user_id", userId)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const { data: cardRows, error: cardErr } = await supabaseAdmin
    .from("submission_cards")
    .select("*")
    .eq("submission_id", id)
    .order("position", { ascending: true });

  if (cardErr) throw cardErr;

  const cards = (cardRows ?? []).map(mapCard);
  await attachAIReports(cards);

  // Replace the raw rows in mapSubmission with mapped+enriched cards
  const submission = mapSubmission(data, []);
  submission.cards = cards;
  submission.cardCount = cards.length;

  // Recompute ROI + totalGradedValue now that cards are populated
  // (mapSubmission was called with empty [])
  const returnedCards = cards.filter((c) => c.gradedValue != null);
  if (returnedCards.length > 0) {
    const value = returnedCards.reduce((s, c) => s + (c.gradedValue ?? 0), 0);
    const basis = returnedCards.reduce(
      (s, c) => s + (c.declaredValue ?? 0) + (c.gradingCost ?? 0),
      0,
    );
    submission.roi = basis > 0 ? ((value - basis) / basis) * 100 : null;
    submission.totalGradedValue = value;
  } else {
    submission.totalGradedValue = null;
  }

  return submission;
};

// ─── Create submission with cards ───────────────────────────────────────────

export const createSubmission = async (
  userId: string,
  input: {
    company: string;
    serviceTier: string;
    submissionNumber?: string;
    trackingToGrader?: string;
    notes?: string;
    cards: CreateCardInput[];
  },
): Promise<GradingSubmission> => {
  if (!input.company) throw new Error("Grading company is required");
  if (!input.serviceTier) throw new Error("Service tier is required");
  if (!input.cards || input.cards.length === 0) {
    throw new Error("At least one card is required");
  }

  const perCardCost = GRADING_COSTS[input.company]?.[input.serviceTier] ?? 0;
  const totalCost = perCardCost * input.cards.length;
  const declaredValueTotal = input.cards.reduce(
    (s, c) => s + (c.declaredValue ?? 0),
    0,
  );
  const now = new Date().toISOString();

  // 1. Insert the envelope
  const { data: envelope, error: envErr } = await supabaseAdmin
    .from("grading_submissions")
    .insert({
      user_id: userId,
      company: input.company,
      service_tier: input.serviceTier,
      status: "submitted",
      submission_number: input.submissionNumber ?? null,
      tracking_to_grader: input.trackingToGrader ?? null,
      notes: input.notes ?? null,
      total_cost: totalCost,
      declared_value_total: declaredValueTotal,
      submitted_at: now,
    })
    .select()
    .single();

  if (envErr) throw envErr;

  // 2. Insert line items
  const cardRows = input.cards.map((c, i) => ({
    submission_id: envelope.id,
    inventory_id: c.inventoryId ?? null,
    card_id: c.cardId ?? null,
    card_name: c.cardName,
    card_set: c.cardSet ?? null,
    card_number: c.cardNumber ?? null,
    card_image: c.cardImage ?? null,
    variant: c.variant ?? null,
    declared_value: c.declaredValue ?? null,
    service_tier: input.serviceTier,
    grading_cost: perCardCost,
    position: i,
    notes: c.notes ?? null,
  }));

  const { data: insertedCards, error: cardErr } = await supabaseAdmin
    .from("submission_cards")
    .insert(cardRows)
    .select();

  if (cardErr) {
    // Roll back envelope if line items failed
    await supabaseAdmin
      .from("grading_submissions")
      .delete()
      .eq("id", envelope.id);
    throw cardErr;
  }

  // 3. Annotate any inventory items linked to this submission
  const inventoryIds = input.cards
    .map((c) => c.inventoryId)
    .filter((v): v is string => Boolean(v));
  if (inventoryIds.length > 0) {
    await supabaseAdmin
      .from("inventory")
      .update({ notes: `Sent to ${input.company} for grading` })
      .in("id", inventoryIds)
      .eq("user_id", userId);
  }

  return mapSubmission(envelope, insertedCards ?? []);
};

// ─── Advance status ─────────────────────────────────────────────────────────

export const advanceStatus = async (
  userId: string,
  id: string,
  updates: {
    trackingFromGrader?: string;
    notes?: string;
  } = {},
): Promise<GradingSubmission> => {
  const current = await getSubmission(userId, id);
  if (!current) throw new Error("Submission not found");

  const idx = STATUS_ORDER.indexOf(current.status);
  if (idx < 0 || idx >= STATUS_ORDER.length - 1) {
    throw new Error("Already at final status");
  }

  const nextStatus = STATUS_ORDER[idx + 1];
  const now = new Date().toISOString();

  const dateField: Record<string, string> = {
    received: "received_at",
    grading: "graded_at",
    shipped_back: "shipped_back_at",
    returned: "returned_at",
  };

  const patch: any = { status: nextStatus, updated_at: now };
  if (updates.trackingFromGrader)
    patch.tracking_from_grader = updates.trackingFromGrader;
  if (updates.notes) patch.notes = updates.notes;
  if (dateField[nextStatus]) patch[dateField[nextStatus]] = now;

  const { error } = await supabaseAdmin
    .from("grading_submissions")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;

  return (await getSubmission(userId, id))!;
};

// ─── Update envelope-level fields ───────────────────────────────────────────

export const updateSubmission = async (
  userId: string,
  id: string,
  updates: Partial<{
    submissionNumber: string;
    trackingToGrader: string;
    trackingFromGrader: string;
    notes: string;
    status: SubmissionStatus;
  }>,
): Promise<GradingSubmission> => {
  const patch: any = { updated_at: new Date().toISOString() };
  if (updates.submissionNumber !== undefined)
    patch.submission_number = updates.submissionNumber;
  if (updates.trackingToGrader !== undefined)
    patch.tracking_to_grader = updates.trackingToGrader;
  if (updates.trackingFromGrader !== undefined)
    patch.tracking_from_grader = updates.trackingFromGrader;
  if (updates.notes !== undefined) patch.notes = updates.notes;
  if (updates.status !== undefined) patch.status = updates.status;

  const { error } = await supabaseAdmin
    .from("grading_submissions")
    .update(patch)
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;

  return (await getSubmission(userId, id))!;
};

// ─── Delete (cascades to submission_cards) ─────────────────────────────────

export const deleteSubmission = async (
  userId: string,
  id: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("grading_submissions")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
};

// ─── Add cards to an existing submission ───────────────────────────────────

export const addCardsToSubmission = async (
  userId: string,
  submissionId: string,
  cards: CreateCardInput[],
): Promise<SubmissionCard[]> => {
  if (!cards || cards.length === 0) throw new Error("No cards provided");

  const submission = await getSubmission(userId, submissionId);
  if (!submission) throw new Error("Submission not found");

  const perCardCost =
    GRADING_COSTS[submission.company]?.[submission.serviceTier ?? ""] ?? 0;

  const rows = cards.map((c, i) => ({
    submission_id: submissionId,
    inventory_id: c.inventoryId ?? null,
    card_id: c.cardId ?? null,
    card_name: c.cardName,
    card_set: c.cardSet ?? null,
    card_number: c.cardNumber ?? null,
    card_image: c.cardImage ?? null,
    variant: c.variant ?? null,
    declared_value: c.declaredValue ?? null,
    service_tier: submission.serviceTier,
    grading_cost: perCardCost,
    position: submission.cardCount + i,
    notes: c.notes ?? null,
  }));

  const { data, error } = await supabaseAdmin
    .from("submission_cards")
    .insert(rows)
    .select();
  if (error) throw error;

  await recomputeEnvelopeTotals(submissionId);
  return (data ?? []).map(mapCard);
};

// ─── Remove a card from a submission ────────────────────────────────────────

export const removeCardFromSubmission = async (
  userId: string,
  submissionCardId: string,
): Promise<void> => {
  // Ownership check via the parent envelope
  const { data: card, error: lookupErr } = await supabaseAdmin
    .from("submission_cards")
    .select("submission_id, grading_submissions!inner(user_id)")
    .eq("id", submissionCardId)
    .maybeSingle();

  if (lookupErr) throw lookupErr;
  if (!card || (card.grading_submissions as any).user_id !== userId) {
    throw new Error("Card not found");
  }

  const { error } = await supabaseAdmin
    .from("submission_cards")
    .delete()
    .eq("id", submissionCardId);
  if (error) throw error;

  await recomputeEnvelopeTotals(card.submission_id);
};

// ─── Update a single card (grade received, cert#, etc.) ────────────────────

export const updateSubmissionCard = async (
  userId: string,
  submissionCardId: string,
  updates: Partial<{
    declaredValue: number;
    gradeReceived: string;
    certNumber: string;
    gradedValue: number;
    aiGradingReportId: string;
    notes: string;
  }>,
): Promise<SubmissionCard> => {
  // Ownership check
  const { data: lookup, error: lookupErr } = await supabaseAdmin
    .from("submission_cards")
    .select(
      "submission_id, inventory_id, grading_submissions!inner(user_id, company)",
    )
    .eq("id", submissionCardId)
    .maybeSingle();

  if (lookupErr) throw lookupErr;
  if (!lookup || (lookup.grading_submissions as any).user_id !== userId) {
    throw new Error("Card not found");
  }

  const patch: any = { updated_at: new Date().toISOString() };
  if (updates.declaredValue !== undefined)
    patch.declared_value = updates.declaredValue;
  if (updates.gradeReceived !== undefined)
    patch.grade_received = updates.gradeReceived;
  if (updates.certNumber !== undefined) patch.cert_number = updates.certNumber;
  if (updates.gradedValue !== undefined)
    patch.graded_value = updates.gradedValue;
  if (updates.aiGradingReportId !== undefined)
    patch.ai_grading_report_id = updates.aiGradingReportId;
  if (updates.notes !== undefined) patch.notes = updates.notes;

  const { data, error } = await supabaseAdmin
    .from("submission_cards")
    .update(patch)
    .eq("id", submissionCardId)
    .select()
    .single();
  if (error) throw error;

  // Sync changes back to the linked inventory item (if any).
  // Two paths:
  //   (a) Grade was just assigned → promote the row to a graded_card
  //   (b) Graded value was entered → mirror to manual_market_value so the
  //       portfolio/inventory view reflects it before the nightly pricing
  //       API catches up.
  if (lookup.inventory_id) {
    const inventoryPatch: any = { updated_at: new Date().toISOString() };

    if (updates.gradeReceived) {
      const company = (lookup.grading_submissions as any).company;
      inventoryPatch.item_type = "graded_card";
      inventoryPatch.grading_company = company;
      inventoryPatch.grade = updates.gradeReceived;
      inventoryPatch.notes = `${company} ${updates.gradeReceived}${
        updates.certNumber ? ` — Cert #${updates.certNumber}` : ""
      }`;
    }

    if (updates.gradedValue !== undefined) {
      inventoryPatch.manual_market_value = updates.gradedValue;
      inventoryPatch.manual_market_value_source = "grading_return";
    }

    // Only write if there's actually something to update
    if (Object.keys(inventoryPatch).length > 1) {
      await supabaseAdmin
        .from("inventory")
        .update(inventoryPatch)
        .eq("id", lookup.inventory_id)
        .eq("user_id", userId);
    }
  }

  await recomputeEnvelopeTotals(lookup.submission_id);
  return mapCard(data);
};

// ─── Helper: recompute envelope totals from line items ─────────────────────

const recomputeEnvelopeTotals = async (submissionId: string): Promise<void> => {
  const { data: cards } = await supabaseAdmin
    .from("submission_cards")
    .select("declared_value, grading_cost")
    .eq("submission_id", submissionId);

  const declaredValueTotal = (cards ?? []).reduce(
    (s, c) => s + (Number(c.declared_value) || 0),
    0,
  );
  const totalCost = (cards ?? []).reduce(
    (s, c) => s + (Number(c.grading_cost) || 0),
    0,
  );

  await supabaseAdmin
    .from("grading_submissions")
    .update({
      declared_value_total: declaredValueTotal,
      total_cost: totalCost,
      updated_at: new Date().toISOString(),
    })
    .eq("id", submissionId);
};

// ─── Pipeline summary (envelope-level totals) ──────────────────────────────

export const getPipelineSummary = async (userId: string) => {
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const { data: envelopes } = await supabaseAdmin
    .from("grading_submissions")
    .select("id, status, total_cost, company, returned_at")
    .eq("user_id", userId);

  const all = envelopes ?? [];
  const active = all.filter((r: any) => r.status !== "returned");
  const returned = all.filter((r: any) => r.status === "returned");

  // Cards from envelopes returned in the last 365 days — used for net P/L
  // and ROI. We restrict to the past year so the KPIs reflect recent
  // performance rather than lifetime totals.
  const recentReturnedIds = returned
    .filter((r: any) => r.returned_at && new Date(r.returned_at) >= oneYearAgo)
    .map((r: any) => r.id);

  let recentCards: any[] = [];
  if (recentReturnedIds.length > 0) {
    const { data } = await supabaseAdmin
      .from("submission_cards")
      .select("declared_value, grading_cost, graded_value")
      .in("submission_id", recentReturnedIds);
    recentCards = data ?? [];
  }

  // Only cards with a graded_value contribute to P/L — un-valued cards are
  // excluded so a missing value doesn't show as a $0 loss.
  const valuedCards = recentCards.filter((c) => c.graded_value != null);
  const totalReturnedValue = valuedCards.reduce(
    (s, c) => s + Number(c.graded_value),
    0,
  );
  const totalCostBasis = valuedCards.reduce(
    (s, c) =>
      s + (Number(c.declared_value) || 0) + (Number(c.grading_cost) || 0),
    0,
  );
  const netProfitLoss1Year = totalReturnedValue - totalCostBasis;

  const totalSpent = all.reduce(
    (s: number, r: any) => s + (Number(r.total_cost) || 0),
    0,
  );

  return {
    totalSubmissions: all.length,
    activeInPipeline: active.length,
    returned: returned.length,
    totalSpentOnGrading: totalSpent, // lifetime cost, kept for reference
    totalReturnedValue, // 1-year window
    netProfitLoss1Year, // 1-year window
    valuedCardCount: valuedCards.length, // for "—" vs $0 disambiguation on the client
    totalROI:
      totalCostBasis > 0 ? (netProfitLoss1Year / totalCostBasis) * 100 : null,
    byStatus: STATUS_ORDER.reduce(
      (acc, s) => {
        acc[s] = all.filter((r: any) => r.status === s).length;
        return acc;
      },
      {} as Record<string, number>,
    ),
    byCompany: ["PSA", "BGS", "CGC", "SGC", "TAG"].reduce(
      (acc, c) => {
        acc[c] = all.filter((r: any) => r.company === c).length;
        return acc;
      },
      {} as Record<string, number>,
    ),
  };
};

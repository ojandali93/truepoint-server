// src/services/gradingLifecycle.service.ts

import { supabaseAdmin } from '../lib/supabase';
import { GRADING_COSTS } from './gradingArbitrage.service';

export type SubmissionStatus =
  | 'submitted'
  | 'received'
  | 'grading'
  | 'shipped_back'
  | 'returned';

export const STATUS_LABELS: Record<SubmissionStatus, string> = {
  submitted:    'Submitted',
  received:     'Received by Grader',
  grading:      'Being Graded',
  shipped_back: 'Shipped Back',
  returned:     'Returned',
};

export const STATUS_ORDER: SubmissionStatus[] = [
  'submitted', 'received', 'grading', 'shipped_back', 'returned',
];

export interface GradingSubmission {
  id: string;
  userId: string;
  inventoryItemId: string | null;
  cardId: string | null;
  cardName: string;
  cardSet: string;
  cardNumber: string | null;
  cardImage: string | null;
  gradingCompany: string;
  serviceTier: string;
  declaredValue: number | null;
  gradingCost: number | null;
  status: SubmissionStatus;
  submittedAt: string;
  receivedAt: string | null;
  gradedAt: string | null;
  shippedBackAt: string | null;
  returnedAt: string | null;
  submissionNumber: string | null;
  trackingToGrader: string | null;
  trackingFromGrader: string | null;
  gradeReceived: string | null;
  certNumber: string | null;
  gradedValue: number | null;
  notes: string | null;
  // Computed
  daysInTransit: number;
  roi: number | null;
}

const mapRow = (row: any): GradingSubmission => {
  const submitted = new Date(row.submitted_at);
  const returned = row.returned_at ? new Date(row.returned_at) : null;
  const daysInTransit = Math.floor(
    ((returned ?? new Date()).getTime() - submitted.getTime()) / (1000 * 60 * 60 * 24)
  );

  let roi: number | null = null;
  if (row.graded_value && row.declared_value && row.grading_cost) {
    const totalCost = (row.declared_value ?? 0) + row.grading_cost;
    roi = totalCost > 0 ? ((row.graded_value - totalCost) / totalCost) * 100 : null;
  }

  return {
    id: row.id,
    userId: row.user_id,
    inventoryItemId: row.inventory_item_id,
    cardId: row.card_id,
    cardName: row.card_name,
    cardSet: row.card_set,
    cardNumber: row.card_number,
    cardImage: row.card_image,
    gradingCompany: row.grading_company,
    serviceTier: row.service_tier,
    declaredValue: row.declared_value,
    gradingCost: row.grading_cost,
    status: row.status,
    submittedAt: row.submitted_at,
    receivedAt: row.received_at,
    gradedAt: row.graded_at,
    shippedBackAt: row.shipped_back_at,
    returnedAt: row.returned_at,
    submissionNumber: row.submission_number,
    trackingToGrader: row.tracking_to_grader,
    trackingFromGrader: row.tracking_from_grader,
    gradeReceived: row.grade_received,
    certNumber: row.cert_number,
    gradedValue: row.graded_value,
    notes: row.notes,
    daysInTransit,
    roi,
  };
};

// ─── Get all submissions ──────────────────────────────────────────────────────

export const getSubmissions = async (
  userId: string,
  status?: SubmissionStatus
): Promise<GradingSubmission[]> => {
  let q = supabaseAdmin
    .from('grading_submissions')
    .select('*')
    .eq('user_id', userId)
    .order('submitted_at', { ascending: false });

  if (status) q = q.eq('status', status);

  const { data } = await q;
  return (data ?? []).map(mapRow);
};

// ─── Get one submission ───────────────────────────────────────────────────────

export const getSubmission = async (
  userId: string,
  id: string
): Promise<GradingSubmission | null> => {
  const { data } = await supabaseAdmin
    .from('grading_submissions')
    .select('*')
    .eq('user_id', userId)
    .eq('id', id)
    .single();

  return data ? mapRow(data) : null;
};

// ─── Create submission ────────────────────────────────────────────────────────

export const createSubmission = async (
  userId: string,
  input: {
    inventoryItemId?: string;
    cardId?: string;
    cardName: string;
    cardSet: string;
    cardNumber?: string;
    cardImage?: string;
    gradingCompany: string;
    serviceTier: string;
    declaredValue?: number;
    submissionNumber?: string;
    trackingToGrader?: string;
    notes?: string;
  }
): Promise<GradingSubmission> => {
  const gradingCost =
    GRADING_COSTS[input.gradingCompany]?.[input.serviceTier] ?? null;

  // If linked to inventory item, mark it as "sent for grading"
  if (input.inventoryItemId) {
    await supabaseAdmin
      .from('inventory')
      .update({ notes: `Sent to ${input.gradingCompany} for grading` })
      .eq('id', input.inventoryItemId)
      .eq('user_id', userId);
  }

  const { data, error } = await supabaseAdmin
    .from('grading_submissions')
    .insert({
      user_id: userId,
      inventory_item_id: input.inventoryItemId ?? null,
      card_id: input.cardId ?? null,
      card_name: input.cardName,
      card_set: input.cardSet,
      card_number: input.cardNumber ?? null,
      card_image: input.cardImage ?? null,
      grading_company: input.gradingCompany,
      service_tier: input.serviceTier,
      declared_value: input.declaredValue ?? null,
      grading_cost: gradingCost,
      status: 'submitted',
      submission_number: input.submissionNumber ?? null,
      tracking_to_grader: input.trackingToGrader ?? null,
      notes: input.notes ?? null,
    })
    .select()
    .single();

  if (error) throw error;
  return mapRow(data);
};

// ─── Advance status ───────────────────────────────────────────────────────────

export const advanceStatus = async (
  userId: string,
  id: string,
  updates: {
    trackingFromGrader?: string;
    gradeReceived?: string;
    certNumber?: string;
    gradedValue?: number;
    notes?: string;
  } = {}
): Promise<GradingSubmission> => {
  const current = await getSubmission(userId, id);
  if (!current) throw new Error('Submission not found');

  const currentIndex = STATUS_ORDER.indexOf(current.status);
  if (currentIndex >= STATUS_ORDER.length - 1) throw new Error('Already at final status');

  const nextStatus = STATUS_ORDER[currentIndex + 1];
  const now = new Date().toISOString();

  const dateFields: Record<string, string> = {
    received:     'received_at',
    grading:      'graded_at',
    shipped_back: 'shipped_back_at',
    returned:     'returned_at',
  };

  const patch: any = {
    status: nextStatus,
    updated_at: now,
    ...updates.trackingFromGrader && { tracking_from_grader: updates.trackingFromGrader },
    ...updates.gradeReceived && { grade_received: updates.gradeReceived },
    ...updates.certNumber && { cert_number: updates.certNumber },
    ...updates.gradedValue && { graded_value: updates.gradedValue },
    ...updates.notes && { notes: updates.notes },
  };

  if (dateFields[nextStatus]) {
    patch[dateFields[nextStatus]] = now;
  }

  // When returned — update inventory item to graded_card with the grade
  if (nextStatus === 'returned' && current.inventoryItemId && updates.gradeReceived) {
    await supabaseAdmin
      .from('inventory')
      .update({
        item_type: 'graded_card',
        grading_company: current.gradingCompany,
        grade: updates.gradeReceived,
        notes: `${current.gradingCompany} ${updates.gradeReceived}${updates.certNumber ? ` — Cert #${updates.certNumber}` : ''}`,
      })
      .eq('id', current.inventoryItemId)
      .eq('user_id', userId);
  }

  const { data, error } = await supabaseAdmin
    .from('grading_submissions')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return mapRow(data);
};

// ─── Update submission details ────────────────────────────────────────────────

export const updateSubmission = async (
  userId: string,
  id: string,
  updates: Partial<{
    submissionNumber: string;
    trackingToGrader: string;
    trackingFromGrader: string;
    declaredValue: number;
    gradeReceived: string;
    certNumber: string;
    gradedValue: number;
    notes: string;
  }>
): Promise<GradingSubmission> => {
  const patch: any = { updated_at: new Date().toISOString() };
  if (updates.submissionNumber !== undefined) patch.submission_number = updates.submissionNumber;
  if (updates.trackingToGrader !== undefined) patch.tracking_to_grader = updates.trackingToGrader;
  if (updates.trackingFromGrader !== undefined) patch.tracking_from_grader = updates.trackingFromGrader;
  if (updates.declaredValue !== undefined) patch.declared_value = updates.declaredValue;
  if (updates.gradeReceived !== undefined) patch.grade_received = updates.gradeReceived;
  if (updates.certNumber !== undefined) patch.cert_number = updates.certNumber;
  if (updates.gradedValue !== undefined) patch.graded_value = updates.gradedValue;
  if (updates.notes !== undefined) patch.notes = updates.notes;

  const { data, error } = await supabaseAdmin
    .from('grading_submissions')
    .update(patch)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single();

  if (error) throw error;
  return mapRow(data);
};

// ─── Delete submission ────────────────────────────────────────────────────────

export const deleteSubmission = async (userId: string, id: string): Promise<void> => {
  await supabaseAdmin
    .from('grading_submissions')
    .delete()
    .eq('id', id)
    .eq('user_id', userId);
};

// ─── Get pipeline summary ─────────────────────────────────────────────────────

export const getPipelineSummary = async (userId: string) => {
  const { data } = await supabaseAdmin
    .from('grading_submissions')
    .select('status, grading_cost, declared_value, graded_value, grade_received, grading_company')
    .eq('user_id', userId);

  const all = data ?? [];
  const active = all.filter((r) => r.status !== 'returned');
  const returned = all.filter((r) => r.status === 'returned');

  const totalSpent = all.reduce((s, r) => s + (r.grading_cost ?? 0), 0);
  const totalValue = returned.reduce((s, r) => s + (r.graded_value ?? 0), 0);
  const totalCostBasis = returned.reduce((s, r) => s + (r.declared_value ?? 0) + (r.grading_cost ?? 0), 0);

  return {
    totalSubmissions: all.length,
    activeInPipeline: active.length,
    returned: returned.length,
    totalSpentOnGrading: totalSpent,
    totalReturnedValue: totalValue,
    totalROI: totalCostBasis > 0 ? ((totalValue - totalCostBasis) / totalCostBasis) * 100 : null,
    byStatus: STATUS_ORDER.reduce((acc, s) => {
      acc[s] = all.filter((r) => r.status === s).length;
      return acc;
    }, {} as Record<string, number>),
    byCompany: ['PSA', 'BGS', 'CGC', 'SGC'].reduce((acc, c) => {
      acc[c] = all.filter((r) => r.grading_company === c).length;
      return acc;
    }, {} as Record<string, number>),
  };
};

// src/repositories/productFeedback.repository.ts
//
// Phase 2 of the in-app feedback system. Deliberately NOT the existing
// feedback.repository.ts (support tickets) — see FEEDBACK_DESIGN.md §1.1.
//
// Two kinds of state live here:
//   - feedback_prompt_state: Flow A's (periodic) 30-day-cooldown /
//     2-dismissal-cap bookkeeping. Its own table.
//   - Flow B2's (cancellation) marker: NOT a new table — three columns
//     already on `subscriptions` (cancel_requested_at, was_trial_at_cancel,
//     exit_feedback_prompted_at), written by billing.service.ts's Stripe
//     path and revenuecat.service.ts's Apple path. This file only reads/
//     resolves them.

import { supabaseAdmin } from "../lib/supabase";

// ─── Flow A: feedback_prompt_state ─────────────────────────────────────────

export interface FeedbackPromptState {
  lastAskedAt: string | null;
  promptCount: number;
  dismissedCount: number;
  respondedAt: string | null;
  optedOut: boolean;
}

const DEFAULT_PROMPT_STATE: FeedbackPromptState = {
  lastAskedAt: null,
  promptCount: 0,
  dismissedCount: 0,
  respondedAt: null,
  optedOut: false,
};

/** No row yet = a user who's never been asked. Defaults, not lazily created —
 * a row only gets written the first time they're actually shown a prompt. */
export const getFeedbackPromptState = async (
  userId: string,
): Promise<FeedbackPromptState> => {
  const { data, error } = await supabaseAdmin
    .from("feedback_prompt_state")
    .select("last_asked_at, prompt_count, dismissed_count, responded_at, opted_out")
    .eq("user_id", userId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  if (!data) return DEFAULT_PROMPT_STATE;
  return {
    lastAskedAt: data.last_asked_at,
    promptCount: data.prompt_count,
    dismissedCount: data.dismissed_count,
    respondedAt: data.responded_at,
    optedOut: data.opted_out,
  };
};

// Read-then-write, not a single atomic increment — Supabase's JS client has
// no "column = column + 1" upsert primitive without a raw RPC, and a single
// user firing two of these concurrently is not a realistic scenario (one
// bottom sheet, one interaction). Same accepted-race tradeoff already used
// elsewhere in this codebase (e.g. renewalReminder's per-row updates).

/** Flow A prompt was shown AND the user answered it. */
export const recordFlowAResponse = async (userId: string): Promise<void> => {
  const current = await getFeedbackPromptState(userId);
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin.from("feedback_prompt_state").upsert(
    {
      user_id: userId,
      last_asked_at: nowIso,
      prompt_count: current.promptCount + 1,
      dismissed_count: current.dismissedCount,
      responded_at: nowIso,
      opted_out: current.optedOut,
      updated_at: nowIso,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
};

/** Flow A prompt was shown and dismissed WITHOUT an answer. 2 dismissals is a
 * PERMANENT stop (opted_out), not a cooldown reset. */
export const recordFlowADismissal = async (userId: string): Promise<void> => {
  const current = await getFeedbackPromptState(userId);
  const nowIso = new Date().toISOString();
  const dismissedCount = current.dismissedCount + 1;
  const { error } = await supabaseAdmin.from("feedback_prompt_state").upsert(
    {
      user_id: userId,
      last_asked_at: nowIso,
      prompt_count: current.promptCount + 1,
      dismissed_count: dismissedCount,
      opted_out: dismissedCount >= 2 ? true : current.optedOut,
      updated_at: nowIso,
    },
    { onConflict: "user_id" },
  );
  if (error) throw error;
};

// ─── Flow B2: subscriptions-backed cancellation marker ─────────────────────

export interface FlowB2GateState {
  pending: boolean;
  cancelledAt: string | null;
  wasTrial: boolean | null;
}

const EMPTY_B2_STATE: FlowB2GateState = {
  pending: false,
  cancelledAt: null,
  wasTrial: null,
};

/** platform != 'comp' is explicit and defensive here, not just structural —
 * comp rows never get cancel_requested_at written by any code path (Stripe/
 * RevenueCat handlers are both platform-scoped), but this query asserts it
 * anyway rather than relying on that silently staying true forever. */
export const getFlowB2GateState = async (
  userId: string,
): Promise<FlowB2GateState> => {
  const { data, error } = await supabaseAdmin
    .from("subscriptions")
    .select("cancel_requested_at, was_trial_at_cancel")
    .eq("user_id", userId)
    .neq("platform", "comp")
    .not("cancel_requested_at", "is", null)
    .is("exit_feedback_prompted_at", null)
    .order("cancel_requested_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  if (!data) return EMPTY_B2_STATE;
  return {
    pending: true,
    cancelledAt: data.cancel_requested_at,
    wasTrial: data.was_trial_at_cancel,
  };
};

/** Resolves (submitted OR dismissed — same effect: stop asking for THIS
 * cancellation) the pending Flow B2 ask. No-op, not an error, if nothing is
 * currently pending — tolerant of client/server state drift, matching this
 * codebase's general tolerance elsewhere (e.g. renewalReminder's sent-marker
 * checks). */
export const resolveFlowB2 = async (userId: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("subscriptions")
    .update({ exit_feedback_prompted_at: new Date().toISOString() })
    .eq("user_id", userId)
    .neq("platform", "comp")
    .not("cancel_requested_at", "is", null)
    .is("exit_feedback_prompted_at", null);
  if (error) throw error;
};

// ─── product_feedback ───────────────────────────────────────────────────────

export interface InsertProductFeedbackInput {
  userId: string;
  feedbackType: "periodic" | "cancellation";
  rating?: number;
  cancellationReasons?: string[];
  wasTrial?: boolean | null;
  freeText?: string;
  triggerContext: string;
  appVersion?: string;
  platform?: "ios" | "android" | "web";
}

export const insertProductFeedback = async (
  input: InsertProductFeedbackInput,
) => {
  const { data, error } = await supabaseAdmin
    .from("product_feedback")
    .insert({
      user_id: input.userId,
      feedback_type: input.feedbackType,
      rating: input.rating ?? null,
      cancellation_reasons: input.cancellationReasons ?? null,
      was_trial: input.wasTrial ?? null,
      free_text: input.freeText ?? null,
      trigger_context: input.triggerContext,
      app_version: input.appVersion ?? null,
      platform: input.platform ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface ProductFeedbackFilters {
  feedbackType?: "periodic" | "cancellation";
  cancellationReason?: string;
  wasTrial?: boolean;
  limit?: number;
  offset?: number;
}

export const listProductFeedback = async (
  filters: ProductFeedbackFilters = {},
) => {
  let q = supabaseAdmin
    .from("product_feedback")
    .select(
      `id, created_at, feedback_type, rating, cancellation_reasons, was_trial,
       free_text, trigger_context, app_version, platform, user_id,
       user:profiles!user_id(id, username, full_name)`,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.feedbackType) q = q.eq("feedback_type", filters.feedbackType);
  if (filters.cancellationReason) {
    q = q.contains("cancellation_reasons", [filters.cancellationReason]);
  }
  if (filters.wasTrial !== undefined) q = q.eq("was_trial", filters.wasTrial);

  q = q.range(
    filters.offset ?? 0,
    (filters.offset ?? 0) + (filters.limit ?? 50) - 1,
  );

  const { data, error, count } = await q;
  if (error) throw error;
  return { feedback: data ?? [], total: count ?? 0 };
};

export interface CancellationReasonBreakdownRow {
  reason: string;
  wasTrial: boolean | null;
  count: number;
}

/** Segmented by trial vs. paid, per FEEDBACK_DESIGN.md Phase 3's addition.
 * Counted in application code, not a grouped SQL aggregate — PostgREST can't
 * unnest an array column (cancellation_reasons — multi-select) in a single
 * filtered aggregate, and this table stays small (one row per submitted
 * cancellation), same rationale as adminAnalytics.service.ts's existing
 * in-memory counts over the small subscriptions table. */
export const getCancellationReasonBreakdown = async (
  days = 90,
): Promise<CancellationReasonBreakdownRow[]> => {
  const sinceIso = new Date(Date.now() - days * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("product_feedback")
    .select("cancellation_reasons, was_trial")
    .eq("feedback_type", "cancellation")
    .gte("created_at", sinceIso);
  if (error) throw error;

  const counts = new Map<string, number>();
  for (const row of data ?? []) {
    const reasons = (row.cancellation_reasons as string[] | null) ?? [];
    const wasTrial = row.was_trial as boolean | null;
    const trialBucket =
      wasTrial === true ? "trial" : wasTrial === false ? "paid" : "unknown";
    for (const reason of reasons) {
      const key = `${reason}::${trialBucket}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries()).map(([key, count]) => {
    const [reason, trialBucket] = key.split("::");
    return {
      reason,
      wasTrial:
        trialBucket === "trial" ? true : trialBucket === "paid" ? false : null,
      count,
    };
  });
};

export interface RatingTrendPoint {
  weekStart: string; // Monday, UTC, YYYY-MM-DD
  averageRating: number;
  count: number;
}

/** No materialization job (unlike card_signals per CLAUDE.md §8) — this
 * table is one row per prompt response, not per price tick. Bucketed in
 * application code for the same reason as the breakdown above. */
export const getRatingTrend = async (weeks = 12): Promise<RatingTrendPoint[]> => {
  const sinceIso = new Date(Date.now() - weeks * 7 * 86_400_000).toISOString();
  const { data, error } = await supabaseAdmin
    .from("product_feedback")
    .select("rating, created_at")
    .eq("feedback_type", "periodic")
    .not("rating", "is", null)
    .gte("created_at", sinceIso)
    .order("created_at", { ascending: true });
  if (error) throw error;

  const buckets = new Map<string, { sum: number; count: number }>();
  for (const row of data ?? []) {
    const d = new Date(row.created_at as string);
    const day = d.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = day === 0 ? 6 : day - 1;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() - diffToMonday);
    monday.setUTCHours(0, 0, 0, 0);
    const key = monday.toISOString().slice(0, 10);
    const bucket = buckets.get(key) ?? { sum: 0, count: 0 };
    bucket.sum += row.rating as number;
    bucket.count += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, { sum, count }]) => ({
      weekStart,
      averageRating: Math.round((sum / count) * 100) / 100,
      count,
    }));
};

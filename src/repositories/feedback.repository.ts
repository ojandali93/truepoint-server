import { supabaseAdmin } from "../lib/supabase";

interface CreateFeedbackInput {
  userId: string;
  category: string;
  message: string;
  appVersion?: string | null;
  platform?: string | null;
  contactEmail?: string | null;
}

export const insertFeedback = async (input: CreateFeedbackInput) => {
  const { data, error } = await supabaseAdmin
    .from("feedback")
    .insert({
      user_id: input.userId,
      category: input.category,
      message: input.message,
      app_version: input.appVersion ?? null,
      platform: input.platform ?? null,
      contact_email: input.contactEmail ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ─── Admin ──────────────────────────────────────────────────────────────────

export interface FeedbackFilters {
  category?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export const listFeedback = async (filters: FeedbackFilters = {}) => {
  let q = supabaseAdmin
    .from("feedback")
    .select(
      `id, created_at, category, message, app_version, platform,
       contact_email, status, admin_notes, resolved_at, user_id,
       user:profiles!user_id(id, username, full_name)`,
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.category) q = q.eq("category", filters.category);
  if (filters.status) q = q.eq("status", filters.status);

  q = q.range(
    filters.offset ?? 0,
    (filters.offset ?? 0) + (filters.limit ?? 50) - 1,
  );

  const { data, error, count } = await q;
  if (error) throw error;
  return { feedback: data ?? [], total: count ?? 0 };
};

export const updateFeedbackStatus = async (
  id: string,
  input: {
    status?: string;
    adminNotes?: string | null;
    resolvedBy?: string | null;
  },
) => {
  const updates: Record<string, unknown> = {};
  if (input.status !== undefined) {
    updates.status = input.status;
    updates.resolved_at =
      input.status === "resolved" ? new Date().toISOString() : null;
    updates.resolved_by =
      input.status === "resolved" ? (input.resolvedBy ?? null) : null;
  }
  if (input.adminNotes !== undefined) updates.admin_notes = input.adminNotes;

  const { data, error } = await supabaseAdmin
    .from("feedback")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

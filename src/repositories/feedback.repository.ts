import { supabaseAdmin } from "../lib/supabase";

interface CreateFeedbackInput {
  userId: string;
  category: string;
  message: string;
  appVersion?: string | null;
  platform?: string | null;
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
    })
    .select()
    .single();
  if (error) throw error;
  return data;
};

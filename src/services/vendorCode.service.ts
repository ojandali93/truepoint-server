import { supabaseAdmin } from "../lib/supabase";

export class VendorCodeError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.code = code;
  }
}

export interface RedeemResult {
  plan: string;
  durationMonths: number;
  trialEndsAt: string;
  description: string | null;
}

/**
 * Redeem a vendor code for the given user. Currently supports `comp_trial`
 * codes: grants a time-boxed comp subscription (status "trialing") that the
 * plan resolver auto-expires, and marks the user's trial as used so the app's
 * own 7-day trial isn't offered later. Self-contained — writes the subscription
 * directly rather than depending on the admin plan helper.
 */
export const redeemVendorCode = async (
  userId: string,
  rawCode: string,
): Promise<RedeemResult> => {
  const code = String(rawCode ?? "")
    .trim()
    .toUpperCase();
  if (!code) throw new VendorCodeError("Enter a code to redeem.", "INVALID");

  const { data: vc, error: vcErr } = await supabaseAdmin
    .from("vendor_codes")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (vcErr) throw vcErr;
  if (!vc || !vc.active)
    throw new VendorCodeError("That code isn't valid.", "NOT_FOUND");
  if (vc.expires_at && new Date(vc.expires_at).getTime() < Date.now())
    throw new VendorCodeError("That code has expired.", "EXPIRED");
  if (vc.max_redemptions != null && vc.redemption_count >= vc.max_redemptions)
    throw new VendorCodeError(
      "That code has reached its redemption limit.",
      "EXHAUSTED",
    );

  // Already redeemed by this user?
  const { data: existing } = await supabaseAdmin
    .from("vendor_code_redemptions")
    .select("id")
    .eq("code_id", vc.id)
    .eq("user_id", userId)
    .maybeSingle();
  if (existing)
    throw new VendorCodeError(
      "You've already redeemed this code.",
      "ALREADY_REDEEMED",
    );

  if (vc.benefit_type !== "comp_trial")
    throw new VendorCodeError(
      "This code type isn't supported yet.",
      "UNSUPPORTED",
    );

  // Grant the comp trial → create or replace the user's subscription.
  const end = new Date();
  end.setMonth(end.getMonth() + (vc.duration_months || 1));
  const endIso = end.toISOString();
  const fields = {
    plan: vc.plan,
    status: "trialing",
    platform: "comp",
    trial_ends_at: endIso,
    current_period_end: endIso,
  };

  const { data: sub } = await supabaseAdmin
    .from("subscriptions")
    .select("id")
    .eq("user_id", userId)
    .limit(1);

  if (sub && sub.length > 0) {
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .update(fields)
      .eq("id", sub[0].id);
    if (error) throw error;
  } else {
    const { error } = await supabaseAdmin
      .from("subscriptions")
      .insert({ user_id: userId, ...fields });
    if (error) throw error;
  }

  // No app 7-day trial later, record the redemption, bump the counter.
  await supabaseAdmin
    .from("profiles")
    .update({ trial_used: true })
    .eq("id", userId);
  await supabaseAdmin
    .from("vendor_code_redemptions")
    .insert({ code_id: vc.id, user_id: userId });
  await supabaseAdmin
    .from("vendor_codes")
    .update({ redemption_count: (vc.redemption_count ?? 0) + 1 })
    .eq("id", vc.id);

  return {
    plan: vc.plan,
    durationMonths: vc.duration_months || 1,
    trialEndsAt: endIso,
    description: vc.description ?? null,
  };
};

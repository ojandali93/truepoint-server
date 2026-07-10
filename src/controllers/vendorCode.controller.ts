import { Request, Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import {
  redeemVendorCode,
  VendorCodeError,
} from "../services/vendorCode.service";
import { supabaseAdmin } from "../lib";

// POST /api/v1/codes/redeem  { code }
export const redeemCode = async (
  req: AuthenticatedRequest,
  res: Response,
): Promise<void> => {
  try {
    if (!req.user?.id) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const result = await redeemVendorCode(req.user.id, req.body?.code);
    res.json({ data: result });
  } catch (err: any) {
    if (err instanceof VendorCodeError) {
      res.status(400).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: err?.message ?? "Failed to redeem code" });
  }
};

// POST /api/v1/codes/validate  { code }  — PUBLIC (no account yet).
// Checks a code is real/active/available and returns its benefit, WITHOUT
// redeeming it. Used by the pre-signup event-code screen and the paywall.
export const validateCode = async (
  req: Request,
  res: Response,
): Promise<void> => {
  try {
    const code = String(req.body?.code ?? "")
      .trim()
      .toUpperCase();
    if (!code) {
      res.json({ data: { valid: false } });
      return;
    }
    const { data: vc } = await supabaseAdmin
      .from("vendor_codes")
      .select(
        "code, description, benefit_type, plan, duration_months, max_redemptions, redemption_count, expires_at, active",
      )
      .eq("code", code)
      .maybeSingle();
    const valid =
      !!vc &&
      vc.active === true &&
      (!vc.expires_at || new Date(vc.expires_at).getTime() >= Date.now()) &&
      (vc.max_redemptions == null || vc.redemption_count < vc.max_redemptions);
    if (!valid || !vc) {
      res.json({ data: { valid: false } });
      return;
    }
    res.json({
      data: {
        valid: true,
        code: vc.code,
        description: vc.description ?? null,
        plan: vc.plan,
        durationMonths: vc.duration_months,
        benefitType: vc.benefit_type,
      },
    });
  } catch {
    res.json({ data: { valid: false } });
  }
};

import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as BillingService from "../services/billing.service";

const handleError = (res: Response, err: unknown) => {
  if (err && typeof err === "object" && "status" in err) {
    const e = err as { status: number; message?: string };
    return res.status(e.status).json({ error: e.message ?? "Error" });
  }
  console.error("[BillingController]", err);
  return res.status(500).json({ error: "An unexpected error occurred" });
};

export const createCheckoutSession = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { plan } = req.body;
    const result = await BillingService.createCheckoutSession(
      req.user.id,
      req.user.email,
      plan,
    );
    res.json({ data: result });
  } catch (err) {
    handleError(res, err);
  }
};

export const verifySession = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const { sessionId } = req.body;
    const subscription = await BillingService.verifyCheckoutSession(
      sessionId,
      req.user.id,
    );
    res.json({ data: subscription });
  } catch (err) {
    handleError(res, err);
  }
};

export const getMySubscription = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const subscription = await BillingService.getSubscription(req.user.id);
    res.json({ data: subscription });
  } catch (err) {
    handleError(res, err);
  }
};

export const cancelMySubscription = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    await BillingService.cancelSubscription(req.user.id);
    res.json({
      message: "Subscription cancelled — access continues until period end",
    });
  } catch (err) {
    handleError(res, err);
  }
};

// Raw body required for Stripe signature verification
export const handleWebhook = async (
  req: AuthenticatedRequest,
  res: Response,
) => {
  try {
    const signature = req.headers["stripe-signature"] as string;
    if (!signature) {
      res.status(400).json({ error: "Missing stripe-signature header" });
      return;
    }
    await BillingService.handleWebhookEvent(req.body as Buffer, signature);
    res.json({ received: true });
  } catch (err) {
    handleError(res, err);
  }
};

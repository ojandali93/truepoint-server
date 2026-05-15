import { Response } from "express";
import { AuthenticatedRequest } from "../types/user.types";
import * as BillingService from "../services/billing.service";
import { logError } from "../lib/Logger";

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
  } catch (err: any) {
    await logError({
      source: "create-checkout-session", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
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
  } catch (err: any) {
    await logError({
      source: "verify-session",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: req.user?.id ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    // Use handleError so the caller can see structured plan/auth errors when
    // applicable; falls through to a generic 500 otherwise.
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
  } catch (err: any) {
    await logError({
      source: "get-subscription", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
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
  } catch (err: any) {
    await logError({
      source: "cancel-subscription", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
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
  } catch (err: any) {
    await logError({
      source: "handle-webhook", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: (req as any)?.userId ?? null,
      requestPath: req.path,
      requestMethod: req.method,
      metadata: { params: req.params, query: req.query },
    });
    res.status(500).json({ error: err?.message });
  }
};

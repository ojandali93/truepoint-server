// src/config/app.ts

import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";

import userRoutes from "../routes/user.routes";
import cardRoutes from "../routes/card.routes";
import centeringRoutes from "../routes/centering.routes";
import { supabase } from "../lib/supabase";
import billingRoutes from "../routes/billing.routes";
import syncRoutes from "../routes/sync.routes";
import inventoryRoutes from "../routes/inventory.route";
import portfolioRoutes from "../routes/portfolio.routes";
import variantRoutes from "../routes/variant.route";
import adminRoutes from "../routes/admin.routes";
import gradingRoutes from "../routes/grading.routes";
import gradingLifecycleRoutes from "../routes/gradingLifecycle.routes";
import aiGradingRoutes from "../routes/aiGrading.routes";
import vendorCodeRoutes from "../routes/vendorCode.routes";
import masterSetRoutes from "../routes/masterSet.routes";
import collectionRoutes from "../routes/collection.routes";
import { errorLoggerMiddleware } from "../middleware/errorLogger.middleware";
import planRoutes from "../routes/plan.routes";
import authRoutes from "../routes/auth.routes";
import feedbackRoutes from "../routes/feedback.routes";
import ebayRoutes from "../routes/ebay.routes";
import affiliateRoutes from "../routes/affiliate.routes";
import affiliateAdminRoutes from "../routes/affiliate.admin.routes";
import outreachAdminRoutes from "../routes/outreach.admin.routes";
import notificationTestRoutes from "../routes/notificationTest.routes";
import tcgPriceLookupTestRoutes from "../routes/tcgPriceLookupTest.routes";
import watchlistRoutes from "../routes/watchlist.routes";
import scanRoutes from "../routes/scan.routes";
import feedbackAdminRoutes from "../routes/feedbackAdmin.routes";
import adminSyncRoutes from "../routes/adminSync.routes";
import regradeRoutes from "../routes/regrade.routes";
import csvImportRoutes from "../routes/csvImport.routes";
import productFeedbackRoutes from "../routes/productFeedback.routes";
import productFeedbackAdminRoutes from "../routes/productFeedbackAdmin.routes";
import eventsRoutes from "../routes/events.routes";
import * as BillingController from "../controllers/billing.controller";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*" }));

// EMERGENCY FIX 2026-08-30 (see BACKLOG.md "Stripe webhook signature
// verification broken since 2026-06-29"): the Stripe webhook needs the
// RAW, unparsed request body to compute/verify its HMAC signature
// (stripe.webhooks.constructEvent, called from billing.service.ts). It
// MUST be mounted here — using its own express.raw() — BEFORE the global
// express.json() below. Once that global parser runs, the body stream is
// already consumed; a later express.raw() (billing.routes.ts used to
// define one on this same path) gets nothing to read and body-parser
// silently leaves req.body as the already-parsed object instead of a
// Buffer, so constructEvent's signature check fails on every delivery.
// This is exactly what happened for two months before being caught — do
// not move this mount below express.json(), and do not reintroduce a
// competing /webhook route in billing.routes.ts (removed from there for
// this reason; this is now the only place it's mounted).
app.post(
  "/api/v1/billing/webhook",
  express.raw({ type: "application/json" }),
  BillingController.handleWebhook as any,
);

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(morgan("combined"));

// IMPORTANT: billingRoutes must be mounted BEFORE the bare-"/api/v1" routers
// (planRoutes / authRoutes). Those routers apply authenticateUser as
// router-level middleware (router.use), which Express runs for EVERY request
// matching the "/api/v1" mount path — even one whose final handler lives in a
// different router. If billing is mounted after them, the unauthenticated
// RevenueCat webhook POST /api/v1/billing/revenuecat-webhook gets intercepted
// and 401'd by the auth router before it ever reaches the billing router.
// Mounting billing first ensures its own (correct) public-webhook ordering wins.
app.use("/api/v1/scan", scanRoutes);

app.use("/api/v1/billing", billingRoutes);
app.use("/api/v1/ebay", ebayRoutes);
app.use("/api/v1", affiliateRoutes);

app.use("/api/v1", planRoutes);
app.use("/api/v1", authRoutes);

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/cards", cardRoutes);
app.use("/api/v1/centering", centeringRoutes);
app.use("/api/v1/sync", syncRoutes);
app.use("/api/v1/inventory", inventoryRoutes);
app.use("/api/v1/import", csvImportRoutes);
app.use("/api/v1/portfolio", portfolioRoutes);
app.use("/api/v1/variants", variantRoutes);
app.use("/api/v1/admin", adminSyncRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/admin", affiliateAdminRoutes);
app.use("/api/v1/admin", outreachAdminRoutes);
app.use("/api/v1/admin", notificationTestRoutes);
app.use("/api/v1/admin", tcgPriceLookupTestRoutes);
app.use("/api/v1/admin", feedbackAdminRoutes);
app.use("/api/v1/admin", productFeedbackAdminRoutes);

app.use("/api/v1/grading", gradingRoutes);
app.use("/api/v1/grading", gradingLifecycleRoutes);
app.use("/api/v1/grading", aiGradingRoutes);
app.use("/api/v1/regrades", regradeRoutes);
app.use("/api/v1/watchlist", watchlistRoutes);
app.use("/api/v1/codes", vendorCodeRoutes);
app.use("/api/v1/master-sets", masterSetRoutes);
app.use("/api/v1/collections", collectionRoutes);
app.use("/api/v1/feedback", feedbackRoutes);
app.use("/api/v1/product-feedback", productFeedbackRoutes);
// Own prefix + per-route auth (not router.use) — /events/anonymous is
// deliberately public, see events.routes.ts's header comment.
app.use("/api/v1/events", eventsRoutes);

app.post("/debug/token", async (req, res) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.json({ error: "no token" });
  const { data, error } = await supabase.auth.getUser(token);
  return res.json({
    user: data?.user?.email,
    role: data?.user?.app_metadata?.role,
    error: error?.message,
  });
});

app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Global error logger — MUST be registered last
// Catches any unhandled error from routes and logs it to error_logs table
app.use(errorLoggerMiddleware as any);

export default app;

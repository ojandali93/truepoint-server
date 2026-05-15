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
import masterSetRoutes from "../routes/masterSet.routes";
import collectionRoutes from "../routes/collection.routes";
import { errorLoggerMiddleware } from "../middleware/errorLogger.middleware";
import planRoutes from "../routes/plan.routes";
import authRoutes from "../routes/auth.routes";

dotenv.config();

const app = express();
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*" }));
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
app.use(morgan("combined"));

app.use("/api/v1", planRoutes);
app.use("/api/v1", authRoutes); // ← add this line

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/cards", cardRoutes);
app.use("/api/v1/centering", centeringRoutes);
app.use("/api/v1/sync", syncRoutes);
app.use("/api/v1/inventory", inventoryRoutes);
app.use("/api/v1/portfolio", portfolioRoutes);
app.use("/api/v1/variants", variantRoutes);
app.use("/api/v1/admin", adminRoutes);
app.use("/api/v1/grading", gradingRoutes);
app.use("/api/v1/grading", gradingLifecycleRoutes);
app.use("/api/v1/grading", aiGradingRoutes);
app.use("/api/v1/master-sets", masterSetRoutes);
app.use("/api/v1/collections", collectionRoutes);

app.use(
  "/api/v1/billing/webhook",
  express.raw({ type: "application/json" }),
  (_req, _res, next) => {
    next();
  },
);
app.use("/api/v1/billing", billingRoutes);

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

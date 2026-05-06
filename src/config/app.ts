import express from "express";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import dotenv from "dotenv";
import userRoutes from "../routes/user.routes";
import cardRoutes from "../routes/card.routes";
import centeringRoutes from "../routes/centering.routes";
import { supabase } from "../lib/supabase";

dotenv.config();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.ALLOWED_ORIGINS?.split(",") ?? "*" }));
app.use(express.json({ limit: "10kb" }));
app.use(morgan("combined"));

app.use("/api/v1/users", userRoutes);
app.use("/api/v1/cards", cardRoutes);
app.use("/api/v1/centering", centeringRoutes);

app.post("/debug/token", async (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader?.split(" ")[1];
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

export default app;

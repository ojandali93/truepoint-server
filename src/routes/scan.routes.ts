// src/routes/scan.routes.ts
import { Router } from "express";

import { authenticateUser } from "../middleware/auth.middleware";
import { writeLimiter } from "../middleware/rateLimit.middleware";
import * as Scan from "../controllers/scan.controller";

const router = Router();
router.use(authenticateUser as any);

// Image identification is a paid external call → writeLimiter.
router.post("/identify", writeLimiter, Scan.identify as any);

export default router;

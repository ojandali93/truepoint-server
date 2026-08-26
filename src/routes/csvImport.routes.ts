// src/routes/csvImport.routes.ts
import { Router } from "express";

import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter, writeLimiter } from "../middleware/rateLimit.middleware";
import * as CsvImport from "../controllers/csvImport.controller";

const router = Router();
router.use(authenticateUser as any);

// Zero-write, no external paid calls — standardLimiter, same as read
// endpoints (writeLimiter is reserved for calls that cost money or write).
router.post("/parse", standardLimiter, CsvImport.parse as any);
router.post("/match", standardLimiter, CsvImport.match as any);

// Writes to inventory — writeLimiter, same as inventory.route.ts's POST.
router.post("/commit", writeLimiter, CsvImport.commit as any);

router.get("/jobs", standardLimiter, CsvImport.listJobs as any);
router.get("/jobs/:id", standardLimiter, CsvImport.getJob as any);

export default router;

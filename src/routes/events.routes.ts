// src/routes/events.routes.ts
//
// Mounted at its own prefix (/api/v1/events, see config/app.ts) — not the
// bare "/api/v1" other routers warn about — so router-level middleware
// would be safe here, but auth is still applied per-route (not
// router.use(authenticateUser)) because /anonymous deliberately has none.

import { Router } from "express";

import { authenticateUser } from "../middleware/auth.middleware";
import { standardLimiter } from "../middleware/rateLimit.middleware";
import { postAnonymousEvents, postEventsBatch } from "../controllers/events.controller";

const router = Router();

router.post(
  "/batch",
  authenticateUser as any,
  standardLimiter,
  postEventsBatch as any,
);

// Public — no session exists yet for install_first_open/signup_started.
// standardLimiter (100/15min per IP) is ample: a real device sends at most
// a couple of requests here, ever.
router.post("/anonymous", standardLimiter, postAnonymousEvents as any);

export default router;

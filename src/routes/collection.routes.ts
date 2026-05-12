// src/routes/collection.routes.ts

import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  listCollections,
  listCollectionsRaw,
  createColl,
  updateColl,
  deleteColl,
  setDefault,
  ensureDefault,
} from "../controllers/collection.controller";

const router = Router();

router.use(authenticateUser as any);

router.get("/", listCollections as any); // with summaries
router.get("/raw", listCollectionsRaw as any); // lightweight, for dropdowns
router.post("/", createColl as any);
router.post("/ensure-default", ensureDefault as any);
router.patch("/:id", updateColl as any);
router.delete("/:id", deleteColl as any);
router.patch("/:id/set-default", setDefault as any);

export default router;

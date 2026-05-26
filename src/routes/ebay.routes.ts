import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  searchEbay,
  analyzeEbayListing,
  getEbayReports,
  deleteEbayReport,
} from "../controllers/ebayArbitrage.controller";

const router = Router();
router.use(authenticateUser as any);
router.get("/search", searchEbay as any);
router.post("/analyze", analyzeEbayListing as any);
router.get("/reports", getEbayReports as any);
router.delete("/reports/:id", deleteEbayReport as any);
export default router;

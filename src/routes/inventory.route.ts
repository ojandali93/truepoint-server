import { Router } from "express";
import { authenticateUser } from "../middleware/auth.middleware";
import {
  standardLimiter,
  writeLimiter,
} from "../middleware/rateLimit.middleware";
import * as InventoryController from "../controllers/inventory.controller";

const router = Router();

router.use(authenticateUser as any);

// ─── Inventory CRUD ───────────────────────────────────────────────────────────

// GET  /api/v1/inventory
// All user inventory items with market values + summary
router.get("/", standardLimiter, InventoryController.getInventory as any);

// POST /api/v1/inventory
// Add a raw card, graded card, or sealed product
router.post("/", writeLimiter, InventoryController.addInventoryItem as any);

// PUT /api/v1/inventory/:id
// Edit an existing inventory item
router.put("/:id", writeLimiter, InventoryController.editInventoryItem as any);

// DELETE /api/v1/inventory/:id
// Remove an inventory item
router.delete(
  "/:id",
  writeLimiter,
  InventoryController.removeInventoryItem as any,
);

// ─── Open sealed product ──────────────────────────────────────────────────────

// POST /api/v1/inventory/:id/open
// Open a sealed product — pass pulled cards, deletes product, inserts raw cards
router.post(
  "/:id/open",
  writeLimiter,
  InventoryController.openSealedProduct as any,
);

export default router;

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

// GET /api/v1/inventory/sold
// Sold items with realized-profit summary (declared before /:id routes)
router.get("/sold", standardLimiter, InventoryController.getSoldItems as any);

// POST /api/v1/inventory
// Add a raw card, graded card, or sealed product
router.post("/", writeLimiter, InventoryController.addInventoryItem as any);

router.post(
  "/batch",
  writeLimiter,
  InventoryController.batchAddInventoryItems as any,
);

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

// PATCH /api/v1/inventory/:id/sold — mark an item sold
router.patch(
  "/:id/sold",
  writeLimiter,
  InventoryController.markItemSold as any,
);

// PATCH /api/v1/inventory/:id/unsell — revert a sale back to active
router.patch(
  "/:id/unsell",
  writeLimiter,
  InventoryController.revertItemSold as any,
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

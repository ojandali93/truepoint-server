/**
 * Trade service.
 *
 * Recording a trade mutates inventory:
 *   • give-side cards (existing inventory rows) are moved out of active
 *     inventory (status='traded') — preserved, not deleted, so the trade can
 *     be reverted.
 *   • get-side cards are inserted as new active inventory rows, with cost
 *     basis = their trade-in value, dropped into the user's default collection.
 *   • a `trades` journal row is written snapshotting both sides, cash on each
 *     side, totals and the net differential, plus the inventory IDs touched so
 *     the trade can be cleanly reverted.
 *
 * Supabase has no multi-statement transaction over the JS client, so the steps
 * run sequentially with a best-effort rollback if anything fails partway.
 */

import { ensureDefaultCollection } from "./collection.service";
import {
  deleteInventoryItem,
  findInventoryItemById,
  insertInventoryItem,
  setInventoryStatus,
  type ItemType,
} from "../repositories/inventory.repository";
import {
  deleteTrade as deleteTradeRow,
  findTradeById,
  findTradesByUser,
  insertTrade,
  type TradeCardSnapshot,
  type TradeRow,
} from "../repositories/trades.repository";

export interface RecordTradeInput {
  giveCards: TradeCardSnapshot[];
  getCards: TradeCardSnapshot[];
  giveCash?: number;
  getCash?: number;
  notes?: string | null;
}

const num = (v: unknown): number => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

function inferItemType(c: TradeCardSnapshot): ItemType {
  if (
    c.itemType === "graded_card" ||
    c.itemType === "raw_card" ||
    c.itemType === "sealed_product"
  ) {
    return c.itemType;
  }
  if (c.gradingCompany) return "graded_card";
  if (c.productId) return "sealed_product";
  return "raw_card";
}

export const recordTrade = async (
  userId: string,
  input: RecordTradeInput,
): Promise<TradeRow> => {
  const giveCards = input.giveCards ?? [];
  const getCards = input.getCards ?? [];
  const giveCash = num(input.giveCash);
  const getCash = num(input.getCash);

  if (
    giveCards.length === 0 &&
    getCards.length === 0 &&
    giveCash === 0 &&
    getCash === 0
  ) {
    throw {
      status: 400,
      message: "A trade needs at least one card or a cash amount",
    };
  }

  // 1. Validate the give side: each card must point at an active inventory row
  //    the user owns.
  const giveRowIds: string[] = [];
  for (const c of giveCards) {
    const invId = c.inventoryId ?? null;
    if (!invId) {
      throw {
        status: 400,
        message: `"${c.name}" on your side isn't linked to an inventory item`,
      };
    }
    const row = await findInventoryItemById(invId);
    if (!row) {
      throw {
        status: 404,
        message: `Inventory item not found for "${c.name}"`,
      };
    }
    if (row.user_id !== userId) {
      throw { status: 403, message: "Access denied" };
    }
    const status = (row as { status?: string }).status;
    if (status && status !== "active") {
      throw {
        status: 400,
        message: `"${c.name}" is no longer in active inventory`,
      };
    }
    giveRowIds.push(invId);
  }

  // 2. Totals (cards + cash on each side).
  const giveCardsTotal = giveCards.reduce((s, c) => s + num(c.value), 0);
  const getCardsTotal = getCards.reduce((s, c) => s + num(c.value), 0);
  const giveTotal = giveCardsTotal + giveCash;
  const getTotal = getCardsTotal + getCash;
  const net = getTotal - giveTotal;

  const tradedIds: string[] = [];
  const createdIds: string[] = [];

  try {
    // 3. Move give-side rows out of active inventory.
    for (const id of giveRowIds) {
      await setInventoryStatus(id, userId, "traded");
      tradedIds.push(id);
    }

    // 4. Insert received cards as new active inventory.
    let defaultCollectionId: string | null = null;
    if (getCards.length > 0) {
      const def = await ensureDefaultCollection(userId);
      defaultCollectionId = def.id;
    }
    for (const c of getCards) {
      const itemType = inferItemType(c);
      const created = await insertInventoryItem(userId, {
        itemType,
        cardId: itemType === "sealed_product" ? null : (c.cardId ?? null),
        productId:
          itemType === "sealed_product"
            ? (c.productId ?? c.cardId ?? null)
            : null,
        gradingCompany: (c.gradingCompany as any) ?? null,
        grade: c.grade ?? null,
        variantType: c.variantType ?? null,
        condition: (c.condition as any) ?? null,
        purchasePrice: num(c.value), // cost basis = trade-in value
        purchaseDate: new Date().toISOString(),
        quantity: 1,
        collection_id: defaultCollectionId,
        notes: "Acquired via trade",
      });
      createdIds.push(created.id);
    }

    // 5. Write the journal entry.
    return await insertTrade(userId, {
      give_cards: giveCards,
      get_cards: getCards,
      give_cash: giveCash,
      get_cash: getCash,
      give_total: giveTotal,
      get_total: getTotal,
      net,
      notes: input.notes ?? null,
      traded_at: new Date().toISOString(),
      traded_inventory_ids: tradedIds,
      created_inventory_ids: createdIds,
    });
  } catch (err) {
    // Best-effort rollback so a partial failure doesn't strand inventory.
    for (const id of createdIds) {
      try {
        await deleteInventoryItem(id, userId);
      } catch (e) {
        console.error("[Trades] rollback: delete created failed", id, e);
      }
    }
    for (const id of tradedIds) {
      try {
        await setInventoryStatus(id, userId, "active");
      } catch (e) {
        console.error("[Trades] rollback: restore give failed", id, e);
      }
    }
    throw err;
  }
};

export const listTrades = (userId: string): Promise<TradeRow[]> =>
  findTradesByUser(userId);

// Revert a trade: restore the given items to active inventory, remove the
// received items, then delete the journal row.
export const deleteTrade = async (
  id: string,
  userId: string,
): Promise<void> => {
  const trade = await findTradeById(id);
  if (!trade) throw { status: 404, message: "Trade not found" };
  if (trade.user_id !== userId) throw { status: 403, message: "Access denied" };

  for (const invId of trade.traded_inventory_ids ?? []) {
    try {
      await setInventoryStatus(invId, userId, "active");
    } catch (e) {
      console.error("[Trades] revert: restore give failed", invId, e);
    }
  }
  for (const invId of trade.created_inventory_ids ?? []) {
    try {
      await deleteInventoryItem(invId, userId);
    } catch (e) {
      console.error("[Trades] revert: remove get failed", invId, e);
    }
  }

  await deleteTradeRow(id, userId);
};

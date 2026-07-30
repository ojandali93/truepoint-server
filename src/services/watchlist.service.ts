// src/services/watchlist.service.ts
//
// Cards a user is tracking, with optional buy-below / sell-above price
// triggers. Deliberately minimal — raw market price only, no grade
// tracking. Trigger DETECTION happens here, computed live on every fetch;
// trigger DELIVERY (an actual push while the app is closed) is a separate,
// later piece of work once the notification system is fixed.

import { supabaseAdmin } from "../lib/supabase";

const TABLE = "watchlist_items";

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
const notFound = (message: string) =>
  Object.assign(new Error(message), { status: 404 });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WatchlistItemInput {
  cardId: string;
  buyBelowPrice?: number | null;
  sellAbovePrice?: number | null;
  notes?: string | null;
}

export interface WatchlistItemRow {
  id: string;
  cardId: string;
  cardName: string;
  cardNumber: string;
  setName: string;
  imageSmall: string | null;
  currentPrice: number | null;
  buyBelowPrice: number | null;
  sellAbovePrice: number | null;
  buyTriggered: boolean;
  sellTriggered: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

const validateInput = (
  input: Partial<WatchlistItemInput>,
  isCreate: boolean,
): void => {
  if (isCreate && !input.cardId) throw badRequest("cardId is required");
  if (
    input.buyBelowPrice != null &&
    (typeof input.buyBelowPrice !== "number" || input.buyBelowPrice < 0)
  ) {
    throw badRequest("buyBelowPrice must be a positive number");
  }
  if (
    input.sellAbovePrice != null &&
    (typeof input.sellAbovePrice !== "number" || input.sellAbovePrice < 0)
  ) {
    throw badRequest("sellAbovePrice must be a positive number");
  }
};

// ─── List ───────────────────────────────────────────────────────────────────

export const listWatchlist = async (
  userId: string,
): Promise<WatchlistItemRow[]> => {
  const { data: rows, error } = await supabaseAdmin
    .from(TABLE)
    .select(
      `
      id, card_id, buy_below_price, sell_above_price, notes,
      created_at, updated_at,
      cards!inner ( id, name, number, image_small, set_id, sets!inner ( name ) )
    `,
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!rows?.length) return [];

  const cardIds = [...new Set(rows.map((r) => r.card_id as string))];

  // Raw market price only — same lookup pattern used elsewhere in this app
  // (gradingArbitrage.service.ts, regradeTracker.service.ts): prefer
  // tcgplayer, fall back to any raw (ungraded) row.
  const { data: priceRows, error: priceErr } = await supabaseAdmin
    .from("market_prices")
    .select("card_id, source, grade, market_price")
    .in("card_id", cardIds)
    .is("grade", null);
  if (priceErr) throw priceErr;

  const priceByCard = new Map<string, number | null>();
  for (const cardId of cardIds) {
    const forCard = (priceRows ?? []).filter((p) => p.card_id === cardId);
    const price =
      forCard.find((p) => p.source === "tcgplayer" && p.market_price != null)
        ?.market_price ??
      forCard.find((p) => p.market_price != null)?.market_price ??
      null;
    priceByCard.set(cardId, price);
  }

  return rows.map((r: any) => {
    const card = r.cards;
    const set = card?.sets;
    const currentPrice = priceByCard.get(r.card_id) ?? null;

    const buyBelowPrice = r.buy_below_price;
    const sellAbovePrice = r.sell_above_price;

    return {
      id: r.id,
      cardId: r.card_id,
      cardName: card?.name ?? "Unknown",
      cardNumber: card?.number ?? "",
      setName: set?.name ?? "",
      imageSmall: card?.image_small ?? null,
      currentPrice,
      buyBelowPrice,
      sellAbovePrice,
      buyTriggered:
        buyBelowPrice != null &&
        currentPrice != null &&
        currentPrice <= buyBelowPrice,
      sellTriggered:
        sellAbovePrice != null &&
        currentPrice != null &&
        currentPrice >= sellAbovePrice,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
};

// ─── Create ─────────────────────────────────────────────────────────────────

export const addToWatchlist = async (
  userId: string,
  input: WatchlistItemInput,
) => {
  validateInput(input, true);

  const { data: card, error: cardErr } = await supabaseAdmin
    .from("cards")
    .select("id")
    .eq("id", input.cardId)
    .maybeSingle();
  if (cardErr) throw cardErr;
  if (!card) throw badRequest(`No card with id "${input.cardId}"`);

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .upsert(
      {
        user_id: userId,
        card_id: input.cardId,
        buy_below_price: input.buyBelowPrice ?? null,
        sell_above_price: input.sellAbovePrice ?? null,
        notes: input.notes ?? null,
      },
      { onConflict: "user_id,card_id" },
    )
    .select("*")
    .single();
  if (error) throw error;
  return data;
};

// ─── Update ─────────────────────────────────────────────────────────────────

const findOwnedOrThrow = async (id: string, userId: string): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw notFound("Watchlist item not found");
  if (data.user_id !== userId) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }
};

export const updateWatchlistItem = async (
  userId: string,
  id: string,
  patch: Partial<WatchlistItemInput>,
): Promise<void> => {
  validateInput(patch, false);
  await findOwnedOrThrow(id, userId);

  const update: Record<string, unknown> = {};
  if (patch.buyBelowPrice !== undefined)
    update.buy_below_price = patch.buyBelowPrice;
  if (patch.sellAbovePrice !== undefined)
    update.sell_above_price = patch.sellAbovePrice;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (Object.keys(update).length === 0) return;

  const { error } = await supabaseAdmin
    .from(TABLE)
    .update(update)
    .eq("id", id)
    .eq("user_id", userId); // belt-and-braces, see findOwnedOrThrow
  if (error) throw error;
};

// ─── Delete ─────────────────────────────────────────────────────────────────

export const removeFromWatchlist = async (
  userId: string,
  id: string,
): Promise<void> => {
  await findOwnedOrThrow(id, userId);
  const { error } = await supabaseAdmin
    .from(TABLE)
    .delete()
    .eq("id", id)
    .eq("user_id", userId);
  if (error) throw error;
};

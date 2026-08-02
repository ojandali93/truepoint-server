// src/services/watchlist.service.ts
//
// Cards, graded cards, OR sealed products a user is tracking, with
// optional buy-below / sell-above price triggers. Trigger DETECTION
// happens here, computed live on every fetch; trigger DELIVERY (an actual
// push while the app is closed) is separate, later work once the
// notification system is fixed.
//
// Every row is exactly one of: a raw card, a card at a specific graded
// tier, or a product — never more than one, enforced by the DB's
// card_xor_product check constraint plus targetCompany/targetGrade only
// being meaningful alongside a cardId.

import { supabaseAdmin } from "../lib/supabase";
import {
  getCardPriceHistory,
  getProductPriceHistory,
} from "./historicPrices.service";

const TABLE = "watchlist_items";
const GRADING_COMPANIES = ["PSA", "BGS", "CGC", "SGC", "TAG"] as const;

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
const notFound = (message: string) =>
  Object.assign(new Error(message), { status: 404 });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WatchlistItemInput {
  cardId?: string | null;
  productId?: string | null;
  targetCompany?: string | null;
  targetGrade?: string | null;
  buyBelowPrice?: number | null;
  sellAbovePrice?: number | null;
  notes?: string | null;
}

export interface SevenDayChange {
  priceThen: number;
  changeAmount: number;
  changePercent: number;
}

export interface WatchlistItemRow {
  id: string;
  kind: "card" | "product";
  cardId: string | null;
  productId: string | null;
  targetCompany: string | null;
  targetGrade: string | null;
  name: string;
  subtitle: string; // set name (+ number for cards), or product type for products
  imageSmall: string | null;
  currentPrice: number | null;
  sevenDayChange: SevenDayChange | null;
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
  if (isCreate) {
    const hasCard = !!input.cardId;
    const hasProduct = !!input.productId;
    if (hasCard === hasProduct) {
      throw badRequest("Provide exactly one of cardId or productId");
    }
  }
  const hasCompany = !!input.targetCompany;
  const hasGrade = !!input.targetGrade;
  if (hasCompany !== hasGrade) {
    throw badRequest(
      "targetCompany and targetGrade must be provided together, or not at all",
    );
  }
  if (hasCompany && !input.cardId) {
    throw badRequest(
      "targetCompany/targetGrade only apply to cards, not products",
    );
  }
  if (hasCompany && !GRADING_COMPANIES.includes(input.targetCompany as any)) {
    throw badRequest(
      `targetCompany must be one of ${GRADING_COMPANIES.join(", ")}`,
    );
  }
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

// ─── Shared price lookup ────────────────────────────────────────────────────
//
// Extracted so the watchlist-trigger cron (watchlistTriggers.service.ts) can
// compute "what's this item worth right now" using the exact same logic as
// the list endpoint, rather than a second implementation that could quietly
// drift from this one. Takes the distinct card/product IDs actually needed
// and returns three lookup closures over one batched fetch each — same
// query shape as before, just reusable.
export const getCurrentPriceLookup = async (
  cardIds: string[],
  productIds: string[],
): Promise<{
  rawPriceFor: (cardId: string) => number | null;
  gradedPriceFor: (
    cardId: string,
    company: string,
    grade: string,
  ) => number | null;
  productPriceFor: (productId: string) => number | null;
}> => {
  const { data: cardPriceRows, error: cardPriceErr } = cardIds.length
    ? await supabaseAdmin
        .from("market_prices")
        .select("card_id, source, grade, market_price")
        .in("card_id", cardIds)
    : { data: [], error: null };
  if (cardPriceErr) throw cardPriceErr;

  const { data: productPriceRows, error: productPriceErr } = productIds.length
    ? await supabaseAdmin
        .from("product_price_cache")
        .select("product_id, source, market_price")
        .in("product_id", productIds)
    : { data: [], error: null };
  if (productPriceErr) throw productPriceErr;

  const rawPriceFor = (cardId: string): number | null => {
    const forCard = (cardPriceRows ?? []).filter(
      (p: any) => p.card_id === cardId && p.grade === null,
    );
    return (
      forCard.find(
        (p: any) => p.source === "tcgplayer" && p.market_price != null,
      )?.market_price ??
      forCard.find((p: any) => p.market_price != null)?.market_price ??
      null
    );
  };

  const gradedPriceFor = (
    cardId: string,
    company: string,
    grade: string,
  ): number | null => {
    const gradeKey = `${company} ${grade}`;
    const row = (cardPriceRows ?? []).find(
      (p: any) =>
        p.card_id === cardId &&
        p.source === "poketrace" &&
        p.grade === gradeKey,
    );
    return row?.market_price ?? null;
  };

  const productPriceFor = (productId: string): number | null => {
    const forProduct = (productPriceRows ?? []).filter(
      (p: any) => p.product_id === productId,
    );
    return (
      forProduct.find(
        (p: any) => p.source === "tcgplayer" && p.market_price != null,
      )?.market_price ??
      forProduct.find((p: any) => p.market_price != null)?.market_price ??
      null
    );
  };

  return { rawPriceFor, gradedPriceFor, productPriceFor };
};

// ─── List ───────────────────────────────────────────────────────────────────

export const listWatchlist = async (
  userId: string,
): Promise<WatchlistItemRow[]> => {
  const { data: rows, error } = await supabaseAdmin
    .from(TABLE)
    .select(
      `
      id, card_id, product_id, target_company, target_grade,
      buy_below_price, sell_above_price, notes, created_at, updated_at,
      cards ( id, name, number, image_small, set_id, tcgapis_product_id, sets ( name ) ),
      products ( id, name, product_type, image_url, set_id, sets ( name ) )
    `,
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!rows?.length) return [];

  const cardRows = rows.filter((r: any) => r.card_id);
  const productRows = rows.filter((r: any) => r.product_id);

  // ── Current prices ──────────────────────────────────────────────────────

  const cardIds = [...new Set(cardRows.map((r: any) => r.card_id as string))];
  const productIds = [
    ...new Set(productRows.map((r: any) => r.product_id as string)),
  ];

  const { rawPriceFor, gradedPriceFor, productPriceFor } =
    await getCurrentPriceLookup(cardIds, productIds);

  // ── 7-day change ────────────────────────────────────────────────────────
  //
  // Reuses historicPrices.service.ts (TCGAPIs-first, DB-fallback for
  // cards) rather than a separate mechanism. Run in parallel — this is N
  // calls for N distinct cards/products on the list, which is the honest
  // cost of live-sourcing this instead of a cached table; acceptable for
  // watchlist-sized lists, worth revisiting if watchlists get very large.
  const sevenDayByCard = new Map<string, SevenDayChange | null>();
  await Promise.all(
    cardIds.map(async (cardId) => {
      const cardRow = cardRows.find((r: any) => r.card_id === cardId) as any;
      const tcgapisId = cardRow?.cards?.tcgapis_product_id ?? null;
      try {
        const history = await getCardPriceHistory(cardId, tcgapisId, "7d");
        sevenDayByCard.set(cardId, computeSevenDayChange(history.series));
      } catch {
        sevenDayByCard.set(cardId, null);
      }
    }),
  );

  const sevenDayByProduct = new Map<string, SevenDayChange | null>();
  await Promise.all(
    productIds.map(async (productId) => {
      try {
        const history = await getProductPriceHistory(productId, "7d");
        sevenDayByProduct.set(productId, computeSevenDayChange(history.series));
      } catch {
        sevenDayByProduct.set(productId, null);
      }
    }),
  );

  // ── Assemble ─────────────────────────────────────────────────────────────

  return rows.map((r: any) => {
    const buyBelowPrice = r.buy_below_price;
    const sellAbovePrice = r.sell_above_price;
    let currentPrice: number | null;
    let name: string;
    let subtitle: string;
    let imageSmall: string | null;
    let sevenDayChange: SevenDayChange | null;
    let kind: "card" | "product";

    if (r.card_id) {
      kind = "card";
      const card = r.cards;
      currentPrice =
        r.target_company && r.target_grade
          ? gradedPriceFor(r.card_id, r.target_company, r.target_grade)
          : rawPriceFor(r.card_id);
      name = card?.name ?? "Unknown card";
      subtitle = [card?.sets?.name, card?.number ? `#${card.number}` : null]
        .filter(Boolean)
        .join("  ·  ");
      imageSmall = card?.image_small ?? null;
      sevenDayChange = sevenDayByCard.get(r.card_id) ?? null;
    } else {
      kind = "product";
      const product = r.products;
      currentPrice = productPriceFor(r.product_id);
      name = product?.name ?? "Unknown product";
      subtitle = [product?.sets?.name, product?.product_type]
        .filter(Boolean)
        .join("  ·  ");
      imageSmall = product?.image_url ?? null;
      sevenDayChange = sevenDayByProduct.get(r.product_id) ?? null;
    }

    return {
      id: r.id,
      kind,
      cardId: r.card_id,
      productId: r.product_id,
      targetCompany: r.target_company,
      targetGrade: r.target_grade,
      name,
      subtitle,
      imageSmall,
      currentPrice,
      sevenDayChange,
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
    } as WatchlistItemRow;
  });
};

/** Picks the earliest and latest points in a 7-day series and expresses
 * the difference. Uses the first variant series that actually has 2+
 * points — for cards this is usually "normal"/"holofoil", for products
 * whatever TCGAPIs' single implicit variant comes back as. */
function computeSevenDayChange(
  series: { variant: string; points: { date: string; price: number }[] }[],
): SevenDayChange | null {
  const usable = series.find((s) => s.points.length >= 2);
  if (!usable) return null;
  const first = usable.points[0];
  const last = usable.points[usable.points.length - 1];
  if (first.price <= 0) return null;
  const changeAmount = last.price - first.price;
  return {
    priceThen: first.price,
    changeAmount,
    changePercent: (changeAmount / first.price) * 100,
  };
}

// ─── Create ─────────────────────────────────────────────────────────────────

export const addToWatchlist = async (
  userId: string,
  input: WatchlistItemInput,
) => {
  validateInput(input, true);

  if (input.cardId) {
    const { data: card, error: cardErr } = await supabaseAdmin
      .from("cards")
      .select("id")
      .eq("id", input.cardId)
      .maybeSingle();
    if (cardErr) throw cardErr;
    if (!card) throw badRequest(`No card with id "${input.cardId}"`);
  } else if (input.productId) {
    const { data: product, error: productErr } = await supabaseAdmin
      .from("products")
      .select("id")
      .eq("id", input.productId)
      .maybeSingle();
    if (productErr) throw productErr;
    if (!product) throw badRequest(`No product with id "${input.productId}"`);
  }

  // No DB-level unique constraint covers this combination (see the
  // migration's header note), so check for an exact duplicate here instead
  // of relying on upsert/onConflict.
  let dupQuery = supabaseAdmin.from(TABLE).select("id").eq("user_id", userId);
  dupQuery = input.cardId
    ? dupQuery
        .eq("card_id", input.cardId)
        .eq("target_company", input.targetCompany ?? null)
        .eq("target_grade", input.targetGrade ?? null)
    : dupQuery.eq("product_id", input.productId as string);
  const { data: dup, error: dupErr } = await dupQuery.maybeSingle();
  if (dupErr) throw dupErr;
  if (dup) throw badRequest("Already on your watchlist");

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert({
      user_id: userId,
      card_id: input.cardId ?? null,
      product_id: input.productId ?? null,
      target_company: input.targetCompany ?? null,
      target_grade: input.targetGrade ?? null,
      buy_below_price: input.buyBelowPrice ?? null,
      sell_above_price: input.sellAbovePrice ?? null,
      notes: input.notes ?? null,
    })
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

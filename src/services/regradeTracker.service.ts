// src/services/regradeTracker.service.ts
//
// Regrade tracker / unowned graded arbitrage. Two halves:
//
//   1) getGradeLadder(cardId) — for ANY card, every known price at every
//      grade+company combo. Read-only, no ownership. This is the engine:
//      subgrades are decision support for the user, they never affect this
//      lookup — price depends only on company + overall grade, same as
//      gradingArbitrage.service.ts already assumes for owned cards.
//
//   2) CRUD for tracked_regrades — a user's list of cards they're
//      considering (not necessarily owning yet). Deliberately decoupled
//      from `inventory`: the buy decision happens BEFORE purchase.
//
// v1 scope: bestProfit = targetPrice − costBasis − gradingCost. This does
// NOT net shipping both ways, insurance, or ~13% selling fees — same
// simplification gradingArbitrage.service.ts already makes for owned cards.
// Netting those is a deliberate fast-follow, not an oversight; flagging it
// here so nobody mistakes this number for the real take-home.

import { supabaseAdmin } from "../lib/supabase";
import { fetchAllByIn } from "../lib/pgFetchAll";
import { GRADING_COSTS } from "./gradingArbitrage.service";

// ─── Shared enums ───────────────────────────────────────────────────────────

const VALID_COMPANIES = new Set(["PSA", "BGS", "CGC", "SGC", "TAG"]);
const VALID_STATUSES = new Set([
  "researching",
  "owned",
  "submitted",
  "returned",
  "sold",
]);

// Cheapest documented tier per company — a default assumption for v1's
// profit estimate, not a claim about what the user will actually pay.
// Matches gradingArbitrage.service.ts's own default ("value" tier, PSA).
const DEFAULT_TIER: Record<string, string> = {
  PSA: "value",
  BGS: "economy",
  CGC: "economy",
  SGC: "economy",
  TAG: "economy",
};

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 });

// ─── Ladder (read-only, no ownership) ──────────────────────────────────────

export interface LadderEntry {
  company: string;
  grade: string; // as parsed off market_prices.grade, e.g. "9.5" / "10"
  gradeValue: number; // parsed float, for numeric sort/grouping on the client
  price: number;
  source: string;
  // PriceCharting attribution linkback (CLAUDE.md license note) — null for
  // every other source, and for pricecharting rows synced before
  // migrations/2026-08-26_market_prices_source_product_id.sql landed.
  sourceProductId: string | null;
}

export interface GradeLadderResult {
  cardId: string;
  cardName: string;
  cardNumber: string;
  setName: string;
  setId: string;
  imageSmall: string | null;
  rarity: string | null;
  rawPrice: number | null; // ungraded market price, for baseline context
  ladder: LadderEntry[]; // sorted by company, then grade ascending
  pricedAsOf: string | null; // most recent fetched_at among the graded rows
}

export const getGradeLadder = async (
  cardId: string,
): Promise<GradeLadderResult> => {
  // cards.set_id → sets.id is a declared FK, so the embedded join is safe
  // here — same pattern gradingArbitrage.service.ts already relies on.
  const { data: card, error: cardErr } = await supabaseAdmin
    .from("cards")
    .select("id, name, number, rarity, image_small, set_id, sets!inner(name)")
    .eq("id", cardId)
    .maybeSingle();

  if (cardErr) throw cardErr;
  if (!card) {
    throw Object.assign(new Error("Card not found"), { status: 404 });
  }

  const { data: priceRows, error: priceErr } = await supabaseAdmin
    .from("market_prices")
    .select("source, grade, market_price, fetched_at, source_product_id")
    .eq("card_id", cardId);

  if (priceErr) throw priceErr;
  const rows = priceRows ?? [];

  const rawPrice =
    rows.find((r) => !r.grade && r.source === "tcgplayer" && r.market_price)
      ?.market_price ??
    rows.find((r) => !r.grade && r.market_price)?.market_price ??
    null;

  // Same parsing gradingArbitrage.service.ts uses: market_prices.grade is
  // written as a space-separated "COMPANY GRADE" string ("BGS 9.5"); split
  // and reuse it here rather than re-deriving the convention.
  const ladder: LadderEntry[] = rows
    .filter((r) => r.grade && r.market_price)
    .map((r) => {
      const parts = r.grade!.split(" ");
      const grade = parts[1] ?? r.grade!;
      return {
        company: parts[0] ?? "UNKNOWN",
        grade,
        gradeValue: parseFloat(grade) || 0,
        price: r.market_price!,
        source: r.source,
        sourceProductId: r.source_product_id ?? null,
      };
    })
    .sort(
      (a, b) =>
        a.company.localeCompare(b.company) || a.gradeValue - b.gradeValue,
    );

  const pricedAsOf =
    rows
      .filter((r) => r.grade && r.market_price && r.fetched_at)
      .map((r) => r.fetched_at as string)
      .sort()
      .pop() ?? null;

  const set = card.sets as any;

  return {
    cardId: card.id,
    cardName: card.name,
    cardNumber: card.number,
    setName: set?.name ?? "",
    setId: card.set_id,
    imageSmall: card.image_small,
    rarity: card.rarity,
    rawPrice,
    ladder,
    pricedAsOf,
  };
};

// ─── Tracked regrades — CRUD, scoped to the owning user ────────────────────

export interface TrackedRegradeInput {
  cardId: string;
  currentCompany?: string | null;
  currentGrade?: string | null;
  subCentering?: number | null;
  subCorners?: number | null;
  subEdges?: number | null;
  subSurface?: number | null;
  targetCompany: string;
  targetGrade: string;
  acquisitionPrice?: number | null;
  status?: string;
  notes?: string | null;
}

const validateCreateInput = (input: TrackedRegradeInput): void => {
  if (!input.cardId) throw badRequest("cardId is required");
  if (!input.targetCompany || !VALID_COMPANIES.has(input.targetCompany)) {
    throw badRequest(
      `targetCompany must be one of ${[...VALID_COMPANIES].join(", ")}`,
    );
  }
  if (!input.targetGrade) throw badRequest("targetGrade is required");

  // current_company and current_grade are a pair — one without the other is
  // meaningless (there's no such thing as "graded, company unknown").
  const hasCompany = !!input.currentCompany;
  const hasGrade = !!input.currentGrade;
  if (hasCompany !== hasGrade) {
    throw badRequest(
      "currentCompany and currentGrade must be provided together, or both omitted",
    );
  }
  if (hasCompany && !VALID_COMPANIES.has(input.currentCompany!)) {
    throw badRequest(
      `currentCompany must be one of ${[...VALID_COMPANIES].join(", ")}`,
    );
  }
  if (input.status && !VALID_STATUSES.has(input.status)) {
    throw badRequest(`status must be one of ${[...VALID_STATUSES].join(", ")}`);
  }
};

export const createTrackedRegrade = async (
  userId: string,
  input: TrackedRegradeInput,
) => {
  validateCreateInput(input);

  const { data, error } = await supabaseAdmin
    .from("tracked_regrades")
    .insert({
      user_id: userId,
      card_id: input.cardId,
      current_company: input.currentCompany ?? null,
      current_grade: input.currentGrade ?? null,
      sub_centering: input.subCentering ?? null,
      sub_corners: input.subCorners ?? null,
      sub_edges: input.subEdges ?? null,
      sub_surface: input.subSurface ?? null,
      target_company: input.targetCompany,
      target_grade: input.targetGrade,
      acquisition_price: input.acquisitionPrice ?? null,
      status: input.status ?? "researching",
      notes: input.notes ?? null,
    })
    .select("*")
    .single();

  if (error) throw error;
  return data;
};

export interface TrackedRegradeRow {
  id: string;
  cardId: string;
  cardName: string;
  cardNumber: string;
  setName: string;
  imageSmall: string | null;
  currentCompany: string | null;
  currentGrade: string | null;
  subCentering: number | null;
  subCorners: number | null;
  subEdges: number | null;
  subSurface: number | null;
  targetCompany: string;
  targetGrade: string;
  targetPrice: number | null;
  currentPrice: number | null; // graded price at current grade, or raw price if ungraded
  acquisitionPrice: number | null;
  gradingCostUsed: number;
  estimatedProfit: number | null; // v1 simplification — see file header
  estimatedROI: number | null;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export const listTrackedRegrades = async (
  userId: string,
): Promise<TrackedRegradeRow[]> => {
  const { data: rows, error } = await supabaseAdmin
    .from("tracked_regrades")
    .select(
      `
      id, card_id, current_company, current_grade,
      sub_centering, sub_corners, sub_edges, sub_surface,
      target_company, target_grade, acquisition_price, status, notes,
      created_at, updated_at,
      cards!inner ( id, name, number, image_small, set_id, sets!inner ( name ) )
    `,
    )
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) throw error;
  if (!rows?.length) return [];

  const cardIds = [...new Set(rows.map((r) => r.card_id as string))];

  // Pagination-safe even though a single user's tracked list is small today
  // — this is the same helper gradingArbitrage.service.ts uses, so behavior
  // stays consistent as the feature grows.
  const allPrices = await fetchAllByIn<{
    card_id: string;
    source: string;
    grade: string | null;
    market_price: number | null;
  }>({
    table: "market_prices",
    columns: "card_id, source, grade, market_price",
    column: "card_id",
    ids: cardIds,
  });

  const pricesByCard = new Map<string, typeof allPrices>();
  for (const p of allPrices ?? []) {
    if (!pricesByCard.has(p.card_id)) pricesByCard.set(p.card_id, []);
    pricesByCard.get(p.card_id)!.push(p);
  }

  return rows.map((r: any) => {
    const card = r.cards;
    const set = card?.sets;
    const prices = pricesByCard.get(r.card_id as string) ?? [];

    const findGraded = (
      company: string | null,
      grade: string | null,
    ): number | null => {
      if (!company || !grade) return null;
      const row = prices.find((p) => {
        if (!p.grade || p.market_price == null) return false;
        const [c, g] = p.grade.split(" ");
        return c === company && g === grade;
      });
      return row?.market_price ?? null;
    };

    const rawPrice =
      prices.find((p) => !p.grade && p.source === "tcgplayer" && p.market_price)
        ?.market_price ??
      prices.find((p) => !p.grade && p.market_price)?.market_price ??
      null;

    const targetPrice = findGraded(r.target_company, r.target_grade);
    const currentPrice =
      r.current_company && r.current_grade
        ? findGraded(r.current_company, r.current_grade)
        : rawPrice;

    const tier = DEFAULT_TIER[r.target_company] ?? "value";
    const gradingCostUsed = GRADING_COSTS[r.target_company]?.[tier] ?? 25;

    // Cost basis: what the user told us they paid, falling back to today's
    // price at their current grade (or raw, if ungraded) when they haven't
    // entered one yet.
    const basis = r.acquisition_price ?? currentPrice ?? null;

    let estimatedProfit: number | null = null;
    let estimatedROI: number | null = null;
    if (targetPrice != null && basis != null) {
      estimatedProfit = targetPrice - basis - gradingCostUsed;
      estimatedROI = (estimatedProfit / (basis + gradingCostUsed)) * 100;
    }

    return {
      id: r.id,
      cardId: r.card_id,
      cardName: card?.name ?? "Unknown",
      cardNumber: card?.number ?? "",
      setName: set?.name ?? "",
      imageSmall: card?.image_small ?? null,
      currentCompany: r.current_company,
      currentGrade: r.current_grade,
      subCentering: r.sub_centering,
      subCorners: r.sub_corners,
      subEdges: r.sub_edges,
      subSurface: r.sub_surface,
      targetCompany: r.target_company,
      targetGrade: r.target_grade,
      targetPrice,
      currentPrice,
      acquisitionPrice: r.acquisition_price,
      gradingCostUsed,
      estimatedProfit,
      estimatedROI,
      status: r.status,
      notes: r.notes,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
};

// Ownership check, fetched fresh — mirrors removeInventoryItem's pattern in
// inventory.service.ts exactly (fetch → 404 if missing → 403 if not yours),
// followed by a belt-and-braces .eq("user_id", ...) on the write itself.
// This check is mandatory, not defensive style: supabaseAdmin uses the
// service role and bypasses RLS entirely, so ownership is enforced ONLY
// here, in application code — the database will not stop a user from
// editing someone else's row if this check is skipped.
const findOwnedOrThrow = async (id: string, userId: string): Promise<void> => {
  const { data, error } = await supabaseAdmin
    .from("tracked_regrades")
    .select("id, user_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw Object.assign(new Error("Tracked regrade not found"), {
      status: 404,
    });
  }
  if (data.user_id !== userId) {
    throw Object.assign(new Error("Access denied"), { status: 403 });
  }
};

export const updateTrackedRegrade = async (
  userId: string,
  id: string,
  patch: Partial<TrackedRegradeInput>,
) => {
  await findOwnedOrThrow(id, userId);

  const update: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };

  if (patch.currentCompany !== undefined) {
    if (
      patch.currentCompany !== null &&
      !VALID_COMPANIES.has(patch.currentCompany)
    ) {
      throw badRequest(
        `currentCompany must be one of ${[...VALID_COMPANIES].join(", ")}`,
      );
    }
    update.current_company = patch.currentCompany;
  }
  if (patch.currentGrade !== undefined)
    update.current_grade = patch.currentGrade;
  if (patch.subCentering !== undefined)
    update.sub_centering = patch.subCentering;
  if (patch.subCorners !== undefined) update.sub_corners = patch.subCorners;
  if (patch.subEdges !== undefined) update.sub_edges = patch.subEdges;
  if (patch.subSurface !== undefined) update.sub_surface = patch.subSurface;
  if (patch.targetCompany !== undefined) {
    if (!VALID_COMPANIES.has(patch.targetCompany)) {
      throw badRequest(
        `targetCompany must be one of ${[...VALID_COMPANIES].join(", ")}`,
      );
    }
    update.target_company = patch.targetCompany;
  }
  if (patch.targetGrade !== undefined) update.target_grade = patch.targetGrade;
  if (patch.acquisitionPrice !== undefined)
    update.acquisition_price = patch.acquisitionPrice;
  if (patch.status !== undefined) {
    if (!VALID_STATUSES.has(patch.status)) {
      throw badRequest(
        `status must be one of ${[...VALID_STATUSES].join(", ")}`,
      );
    }
    update.status = patch.status;
  }
  if (patch.notes !== undefined) update.notes = patch.notes;

  const { data, error } = await supabaseAdmin
    .from("tracked_regrades")
    .update(update)
    .eq("id", id)
    .eq("user_id", userId) // belt-and-braces — see findOwnedOrThrow's comment
    .select("*")
    .single();

  if (error) throw error;
  return data;
};

export const deleteTrackedRegrade = async (
  userId: string,
  id: string,
): Promise<void> => {
  await findOwnedOrThrow(id, userId);

  const { error } = await supabaseAdmin
    .from("tracked_regrades")
    .delete()
    .eq("id", id)
    .eq("user_id", userId); // belt-and-braces — see findOwnedOrThrow's comment

  if (error) throw error;
};

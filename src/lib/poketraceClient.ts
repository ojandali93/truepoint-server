// src/lib/poketraceClient.ts
//
// Thin client for the PokeTrace API (via RapidAPI).
//
// V1 use case: fetch graded card prices for one card (by TCGPlayer product ID)
// or for a small batch of cards. Returns the raw response so the sync service
// can decide which fields to use.
//
// PokeTrace's `refs.tcgplayerId` matches our cards.id directly (we verified
// this: cards.id is stored as the string form of TCGPlayer's integer product
// ID, e.g. "42382" for Base Set Charizard).
//
// Env vars:
//   POKETRACE_RAPIDAPI_KEY   RapidAPI key (Pro plan unlocks graded data)
//   POKETRACE_RAPIDAPI_HOST  default "poketrace-api.p.rapidapi.com"

import axios, { AxiosRequestConfig } from "axios";

import { logError } from "./Logger";

const HOST =
  process.env.POKETRACE_RAPIDAPI_HOST ?? "poketrace-api.p.rapidapi.com";
const BASE = `https://${HOST}`;

// PokeTrace returns up to 20 cards per /cards request. We always use this
// max because price queries are by tcgplayer_ids list (batched).
const PAGE_LIMIT = 20;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with retry/backoff — mirrors tcgapisGet in tcgapisClient.ts exactly,
 * so both third-party clients fail the same way.
 *
 * Before this existed, a single 429 threw immediately and killed whatever
 * called it: a bulk-sync batch lost all 20 cards in it, and an on-demand
 * card-detail fetch just errored. Neither is visible as "PokeTrace is rate
 * limiting us" from the caller's side — it looks identical to "this grade
 * genuinely has no market data", which is the wrong failure mode for a
 * feature (the regrade tracker) whose entire value is grade-price coverage.
 *
 * Only logs to error_logs on FINAL failure, not every transient retry — same
 * reasoning as tcgapisGet: keeps the admin error log signal-rich instead of
 * noisy with retries that self-healed.
 */
const poketraceGet = async <T>(
  url: string,
  config: AxiosRequestConfig,
  retries = 3,
): Promise<T> => {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.get<T>(url, config);
      return res.data;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;

      // Rate limited — wait and retry (don't count as a retry attempt burn),
      // same 30s wait tcgapisGet uses.
      if (status === 429) {
        await sleep(30000);
        continue;
      }
      // Auth / plan errors are not retryable — RapidAPI returns 401 for a
      // bad/expired key and 403 when the key isn't subscribed to this API.
      // Fail fast and loud rather than burning retries on something that
      // will never succeed.
      if (status === 401 || status === 402 || status === 403) {
        await logError({
          source: "poketrace-plan-restriction",
          message: `Auth/plan restriction on ${url}: ${err?.response?.data?.message ?? status}`,
          error: err,
          userId: null,
          requestPath: url,
          requestMethod: "GET",
          metadata: { params: config.params ?? {} },
        });
        throw new Error(
          `PokeTrace auth/plan restriction: ${err?.response?.data?.message ?? url}`,
        );
      }
      // Transient — backoff and retry.
      if (i < retries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
    }
  }
  // Final failure — log once.
  await logError({
    source: "poketrace-get",
    message: lastErr?.message ?? `Failed after ${retries} retries: ${url}`,
    error: lastErr,
    userId: null,
    requestPath: url,
    requestMethod: "GET",
    metadata: { params: config.params ?? {} },
  });
  throw lastErr ?? new Error(`Failed after ${retries} retries: ${url}`);
};

// ─── Types (subset we actually use; PokeTrace returns much more) ──────────────

export interface PoketraceGradeStat {
  avg: number | null;
  low: number | null;
  high: number | null;
  lastUpdated: string | null;
  avg1d: number | null;
  avg7d: number | null;
  avg30d: number | null;
  median3d: number | null;
  median7d: number | null;
  median30d: number | null;
  saleCount: number | null;
  approxSaleCount: boolean | null;
}

// Each "prices" block (e.g. "ebay", "tcgplayer") is a map from grade-or-
// condition key → grade stats. Keys mix together:
//   - Condition strings: "NEAR_MINT", "LIGHTLY_PLAYED", "MODERATELY_PLAYED",
//     "HEAVILY_PLAYED", "DAMAGED"
//   - Graded strings: "PSA_10", "PSA_9", "BGS_9_5", "CGC_10", "SGC_8",
//     "TAG_10", "ACE_5", etc.  Half-grades use "_5" suffix.
export type PoketracePriceBlock = Record<string, PoketraceGradeStat>;

export interface PoketraceCard {
  id: string;
  name: string;
  cardNumber: string | null;
  set: { slug: string | null; name: string | null } | null;
  variant: string | null;
  rarity: string | null;
  productType: string | null;
  game: string | null;
  market: string | null;
  currency: string | null;
  image: string | null;
  refs: {
    tcgplayerId: string | null;
    cardmarketId: string | null;
  };
  prices: {
    ebay?: PoketracePriceBlock;
    tcgplayer?: PoketracePriceBlock;
  };
  lastUpdated: string | null;
}

interface CardsResponse {
  data: PoketraceCard[];
  pagination: { hasMore: boolean; nextCursor: string | null; count: number };
}

// ─── Auth check ──────────────────────────────────────────────────────────────

const ensureConfigured = (): void => {
  if (!process.env.POKETRACE_RAPIDAPI_KEY) {
    throw {
      status: 503,
      message:
        "PokeTrace not configured — POKETRACE_RAPIDAPI_KEY missing in env",
    };
  }
};

const baseHeaders = (): AxiosRequestConfig["headers"] => ({
  "x-rapidapi-key": process.env.POKETRACE_RAPIDAPI_KEY as string,
  "x-rapidapi-host": HOST,
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Fetch one or more cards by TCGPlayer product ID. PokeTrace accepts up to 20
 * IDs per call (comma-separated). Returns the matched cards; cards PokeTrace
 * doesn't have are simply absent from the response.
 *
 * NOTE: We do NOT pass has_graded=true here. On the Pro plan, graded fields are
 * always included when present, and we DO want non-graded cards back (so the
 * caller can still cache the empty-graded result and avoid re-fetching).
 */
export const fetchCardsByTcgplayerIds = async (
  tcgplayerIds: string[],
): Promise<PoketraceCard[]> => {
  ensureConfigured();
  if (tcgplayerIds.length === 0) return [];
  if (tcgplayerIds.length > PAGE_LIMIT) {
    throw new Error(
      `PokeTrace caps tcgplayer_ids at ${PAGE_LIMIT} per call (got ${tcgplayerIds.length})`,
    );
  }

  const data = await poketraceGet<CardsResponse>(`${BASE}/cards`, {
    headers: baseHeaders(),
    params: {
      tcgplayer_ids: tcgplayerIds.join(","),
      limit: PAGE_LIMIT,
    },
    timeout: 20000,
  });

  return data?.data ?? [];
};

// Convenience: fetch a single card by TCGPlayer ID. Returns null if missing.
export const fetchCardByTcgplayerId = async (
  tcgplayerId: string,
): Promise<PoketraceCard | null> => {
  const cards = await fetchCardsByTcgplayerIds([tcgplayerId]);
  return cards[0] ?? null;
};

// ─── Helpers — extract graded prices from a PokeTrace card ───────────────────

// The set of grade-key prefixes we treat as "graded" (vs raw conditions).
const GRADE_COMPANIES = ["PSA", "BGS", "CGC", "SGC", "TAG", "ACE"] as const;
export type PoketraceCompany = (typeof GRADE_COMPANIES)[number];

const isGradeKey = (key: string): boolean =>
  GRADE_COMPANIES.some((c) => key.startsWith(`${c}_`));

// Turn PokeTrace's grade key ("PSA_10", "BGS_9_5") into our market_prices.grade
// text shape ("PSA 10", "BGS 9.5") so the existing inventory.repository
// fetchCardPrices() parser can split on whitespace.
//
//   "PSA_10"  → "PSA 10"
//   "BGS_9_5" → "BGS 9.5"
//   "CGC_10"  → "CGC 10"
//   "TAG_8_5" → "TAG 8.5"
export const poketraceKeyToGradeString = (key: string): string => {
  const [company, ...rest] = key.split("_");
  if (rest.length === 0) return key;
  // Join the remaining parts back, then turn "9_5" → "9.5"
  const gradePart = rest.join("_").replace(/_/g, ".");
  return `${company} ${gradePart}`;
};

export interface ExtractedGrade {
  company: PoketraceCompany;
  // Grade string AS WRITTEN to market_prices.grade ("PSA 10" / "BGS 9.5")
  gradeString: string;
  marketPrice: number;
  saleCount: number | null;
  lastUpdated: string | null;
}

// Pull every graded entry from the ebay block. We use ebay (sold data) for
// graded values per design decision — it has way more grade coverage than the
// tcgplayer block (which barely has graded entries). We use the 7-day average
// when available, falling back to the 30-day, then the latest avg, to smooth
// outliers without going so wide that today's market is hidden.
export const extractGradedPrices = (card: PoketraceCard): ExtractedGrade[] => {
  const block = card.prices?.ebay ?? {};
  const out: ExtractedGrade[] = [];

  for (const [key, stat] of Object.entries(block)) {
    if (!isGradeKey(key)) continue;

    // Pick the best representative price: prefer 7-day avg, then 30-day, then
    // the bare avg. Skip entries with no usable price.
    const price = stat.avg7d ?? stat.avg30d ?? stat.avg;
    if (price == null || !isFinite(price) || price <= 0) continue;

    const [company] = key.split("_") as [PoketraceCompany];
    out.push({
      company,
      gradeString: poketraceKeyToGradeString(key),
      marketPrice: Number(price),
      saleCount: stat.saleCount ?? null,
      lastUpdated: stat.lastUpdated,
    });
  }

  return out;
};

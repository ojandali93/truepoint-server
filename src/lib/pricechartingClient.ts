// src/lib/pricechartingClient.ts
//
// Thin client for the PriceCharting Prices API.
//
// Field mapping verified in Phase A of the PriceCharting eval (2026-08-25)
// against PriceCharting's live API + their own `/api-documentation` page
// (the docs page's "Condition ID" table is stale/video-game-oriented and
// contradicts the live JSON — the "Prices API: Description of Keys" table
// on the same page is the authoritative one; see CLAUDE.md §6). Codified
// here as CLAUDE.md §6, LOCKED 2026-08-25, AMENDED 2026-08-25:
//
//   manual-only-price   → PSA 10
//   bgs-10-price        → BGS 10
//   condition-17-price  → CGC 10
//   condition-18-price  → SGC 10
//   condition-19-price  → CGC 10 Pristine
//   condition-20-price  → BGS 10 Black (Black Label)
//   condition-21-price  → TAG 10
//   condition-22-price  → ACE 10
//
// Everything else PriceCharting returns (loose-price, cib-price, new-price,
// graded-price, box-only-price, condition-9..16-price) is a company-blended
// sub-10 field — NEVER read, per the locked contract. This client doesn't
// even bother extracting them.
//
// tcg-id caveat (verified in Phase A): PriceCharting has no batch-by-id or
// search-by-tcg-id endpoint — matching to our cards.id requires a full-text
// search (q=) then filtering candidates by tcg-id === cards.id. tcg-id is
// undocumented and NOT always reliable for premium print variants (1st
// Edition/Shadowless collision verified on Base Set Charizard) — a search
// match is accepted here as-is; variant-flagged cards are a known gap, not
// silently "fixed" by this client.
//
// Prices are pennies (int) per PriceCharting's own docs — divided to
// dollars at the boundary here, so nothing downstream ever sees cents.
//
// RATE LIMIT — sacred, not a suggestion: PriceCharting's API is hard-capped
// at 1 call/second; exceeding it gets calls blocked and, if it persists,
// account permissions revoked (their words, /api-documentation). There is
// exactly ONE function in this file that reaches the network
// (pricechartingSearch), and every call to it — including retries — passes
// through a single serialized throttle gate below. There is no other path
// to the API from this file, and no way to call the gate twice for one
// logical request.
//
// Env var: PRICECHARTING_API_TOKEN (Render + local .env), sent as `t=`.

import axios from "axios";

import { logError } from "./Logger";

const BASE = "https://www.pricecharting.com/api";

// Spacing between calls. PriceCharting's limit is 1/sec exactly; 1.1s is a
// deliberate margin, not a rounding choice — see rate-limit note above.
const MIN_INTERVAL_MS = 1100;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Serialized throttle gate ────────────────────────────────────────────
//
// A flat "sleep before this call" inside the request function would still
// let two concurrent callers (e.g. an accidental Promise.all) race past the
// spacing check simultaneously. This chains every call through one promise
// queue instead, so calls are strictly serialized AND spaced ≥MIN_INTERVAL_MS
// apart regardless of caller concurrency.
let gateQueue: Promise<void> = Promise.resolve();
let lastCallAt = 0;

const acquireSlot = (): Promise<void> => {
  const prev = gateQueue;
  let release: () => void = () => {};
  gateQueue = new Promise((r) => {
    release = r;
  });
  return prev.then(async () => {
    const wait = Math.max(0, lastCallAt + MIN_INTERVAL_MS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    release();
  });
};

// ─── Types ────────────────────────────────────────────────────────────────

export interface PriceChartingProduct {
  id: string;
  "product-name": string;
  "console-name": string;
  "tcg-id"?: string;
  "manual-only-price"?: number | null;
  "bgs-10-price"?: number | null;
  "condition-17-price"?: number | null;
  "condition-18-price"?: number | null;
  "condition-19-price"?: number | null;
  "condition-20-price"?: number | null;
  "condition-21-price"?: number | null;
  "condition-22-price"?: number | null;
  [key: string]: unknown;
}

interface ProductsResponse {
  status?: string;
  "error-message"?: string;
  products?: PriceChartingProduct[];
}

// ─── Auth check ──────────────────────────────────────────────────────────

const ensureConfigured = (): void => {
  if (!process.env.PRICECHARTING_API_TOKEN) {
    throw {
      status: 503,
      message:
        "PriceCharting not configured — PRICECHARTING_API_TOKEN missing in env",
    };
  }
};

// ─── The one network call in this file ────────────────────────────────────

/**
 * GET /api/products?q=... — the only function in this file that reaches the
 * network. Every call (including retries) goes through acquireSlot() first.
 *
 * Retry policy is deliberately conservative given the revocation risk:
 *   429 → back off 10s (not the usual short backoff) and retry, capped
 *   401/403 → auth/plan error, not retryable, fail fast and loud
 *   other → short backoff, retry
 */
const pricechartingGet = async (
  query: string,
  retries = 3,
): Promise<PriceChartingProduct[]> => {
  ensureConfigured();
  const token = process.env.PRICECHARTING_API_TOKEN as string;

  let lastErr: any = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    await acquireSlot();
    try {
      const res = await axios.get<ProductsResponse>(`${BASE}/products`, {
        params: { t: token, q: query },
        timeout: 20000,
      });
      return res.data?.products ?? [];
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;

      if (status === 429) {
        // Deliberately long backoff — PriceCharting's own docs say
        // persistent overage risks account revocation. This is not a
        // feature-availability tradeoff like PokeTrace's 429 handling;
        // it's a "protect the account" one.
        await sleep(10000);
        continue;
      }
      if (status === 401 || status === 403) {
        await logError({
          source: "pricecharting-auth",
          message: `Auth/plan restriction on PriceCharting search: ${
            err?.response?.data?.["error-message"] ?? status
          }`,
          error: err,
          userId: null,
          requestPath: `${BASE}/products`,
          requestMethod: "GET",
          metadata: { query },
        });
        throw new Error(
          `PriceCharting auth/plan restriction: ${
            err?.response?.data?.["error-message"] ?? query
          }`,
        );
      }
      if (attempt < retries - 1) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
    }
  }

  await logError({
    source: "pricecharting-get",
    message: lastErr?.message ?? `Failed after ${retries} retries: ${query}`,
    error: lastErr,
    userId: null,
    requestPath: `${BASE}/products`,
    requestMethod: "GET",
    metadata: { query },
  });
  throw lastErr ?? new Error(`Failed after ${retries} retries: ${query}`);
};

// ─── Public API ─────────────────────────────────────────────────────────

/** Build the search query the same way Phase A's eval script did (97.3%
 * match rate verified against 301 real cards): "<card name> <set name>". */
export const buildSearchQuery = (
  cardName: string,
  setName: string | null,
): string => [cardName, setName].filter(Boolean).join(" ");

/**
 * Search PriceCharting and return the candidate whose tcg-id matches our
 * cards.id exactly. Null if no candidate matches (search miss OR a genuine
 * "PriceCharting doesn't carry this card" case — this function can't tell
 * those apart, same limitation noted in Phase A).
 */
export const findProductByTcgId = async (
  cardName: string,
  setName: string | null,
  cardId: string,
): Promise<PriceChartingProduct | null> => {
  const query = buildSearchQuery(cardName, setName);
  const products = await pricechartingGet(query);
  return (
    products.find((p) => String(p["tcg-id"]) === String(cardId)) ?? null
  );
};

// ─── Grade extraction — the LOCKED 10-tier + Black Label field map ───────

export interface ExtractedGrade {
  company: "PSA" | "BGS" | "CGC" | "SGC" | "TAG" | "ACE";
  gradeString: string; // as written to market_prices.grade
  marketPrice: number; // dollars, converted from PriceCharting's cents
}

interface FieldMapping {
  field: keyof PriceChartingProduct;
  company: ExtractedGrade["company"];
  gradeString: string;
}

// Order matters not at all here — every field is independent, no fallback
// between them (that would violate "one source per tier, no seams").
const TEN_TIER_FIELDS: FieldMapping[] = [
  { field: "manual-only-price", company: "PSA", gradeString: "PSA 10" },
  { field: "bgs-10-price", company: "BGS", gradeString: "BGS 10" },
  { field: "condition-17-price", company: "CGC", gradeString: "CGC 10" },
  { field: "condition-18-price", company: "SGC", gradeString: "SGC 10" },
  { field: "condition-19-price", company: "CGC", gradeString: "CGC 10 Pristine" },
  { field: "condition-20-price", company: "BGS", gradeString: "BGS 10 Black" },
  { field: "condition-21-price", company: "TAG", gradeString: "TAG 10" },
  { field: "condition-22-price", company: "ACE", gradeString: "ACE 10" },
];

/**
 * Pull every 10-tier / Black Label / Pristine price out of a matched
 * PriceCharting product. Cents → dollars here, so nothing downstream ever
 * sees cents. Skips fields that are null/0/missing — PriceCharting returns
 * 0 rather than omitting a field it has no data for.
 */
export const extractTenTierPrices = (
  product: PriceChartingProduct,
): ExtractedGrade[] => {
  const out: ExtractedGrade[] = [];
  for (const { field, company, gradeString } of TEN_TIER_FIELDS) {
    const cents = product[field] as number | null | undefined;
    if (cents == null || !isFinite(cents) || cents <= 0) continue;
    out.push({ company, gradeString, marketPrice: cents / 100 });
  }
  return out;
};

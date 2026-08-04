// src/lib/tcgPriceLookupClient.ts
//
// TESTING-ONLY client for TCG Price Lookup (tcgpricelookup.com) —
// evaluating as a possible replacement for PokeTrace's graded pricing.
// The pitch that got this far: one vendor covering Pokemon (English AND
// Japanese, tracked separately), One Piece (also English/Japanese,
// tracked separately), and PSA/BGS/CGC/SGC/ACE/TAG graded prices
// including BGS Black Label — confirmed from their own docs, blog, and
// SDK READMEs, none of which I could get a live authenticated response
// from (their API isn't in this sandbox's network allowlist).
//
// Entirely isolated from the production graded-price pipeline — nothing
// here writes to market_prices or touches poketracePriceSync.service.ts.
// Read-only, admin diagnostic only, until/unless a real transition
// decision gets made.
//
// Env var: TCGPRICELOOKUP_API_KEY
//
// Auth: X-API-Key header (confirmed from their official Postman
// collection's auth block — different from PokemonPriceTracker's Bearer
// token, and different again from PokeTrace's own X-API-Key-over-RapidAPI
// setup, so don't assume any of these three vendors share a convention).
//
// IMPORTANT — response shape uncertainty, on purpose: I could confirm the
// RAW price path from their CLI docs' own jq example —
// `.data[0].prices.raw.near_mint.tcgplayer.market` — which tells us
// `prices.raw.*` is real. I could NOT find an equally-confirmed example
// of the GRADED price path (`prices.graded.*` is a reasonable guess by
// pattern, not a verified fact). Rather than hardcode a guessed field
// path that might silently return nothing even if the data IS there
// under a slightly different structure, this client returns the FULL
// raw response AND a best-effort recursive scan for anything
// grading-shaped anywhere in the object tree. The diagnostic UI shows
// both — the scan for a quick read, the raw JSON so a human can verify
// nothing was missed.

import axios from "axios";

import { logError } from "./Logger";

const BASE = "https://api.tcgpricelookup.com/v1";

const GRADE_HINT_PATTERN =
  /^(psa|bgs|cgc|sgc|ace|tag)|black[_\s-]?label|pristine|perfect|gem[_\s-]?mint/i;

export interface GradingHit {
  /** Dot-path to where this was found in the response tree, e.g.
   * "data.prices.graded.bgs.blacklabel.ebay.average" — so a human can go
   * look at the raw JSON at that exact spot. */
  path: string;
  key: string;
  value: unknown;
}

/**
 * Recursively walks any JSON-shaped value looking for object keys that
 * look grading-related — a known company prefix (psa/bgs/cgc/sgc/ace/tag)
 * OR a special-tier word (black label, pristine, perfect, gem mint).
 * Deliberately broad and a little noisy — for a diagnostic tool, a false
 * positive costs a human two seconds of reading; a false negative costs
 * missing the one thing we're actually here to check for.
 */
export const scanForGradingKeys = (
  value: unknown,
  path = "",
  out: GradingHit[] = [],
): GradingHit[] => {
  if (value == null || typeof value !== "object") return out;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (GRADE_HINT_PATTERN.test(key)) {
      out.push({ path: childPath, key, value: child });
    }
    if (child != null && typeof child === "object") {
      scanForGradingKeys(child, childPath, out);
    }
  }
  return out;
};

const tplGet = async <T>(
  path: string,
  params: Record<string, unknown>,
): Promise<T> => {
  const key = process.env.TCGPRICELOOKUP_API_KEY;
  if (!key) {
    throw new Error(
      "TCGPRICELOOKUP_API_KEY is not set — add it to the backend env before testing.",
    );
  }
  try {
    const res = await axios.get<T>(`${BASE}${path}`, {
      headers: { "X-API-Key": key },
      params,
      timeout: 15000,
    });
    return res.data;
  } catch (err: any) {
    await logError({
      source: "tcgpricelookup-test",
      message: err?.message ?? `Failed: ${path}`,
      error: err,
      userId: null,
      requestPath: path,
      requestMethod: "GET",
      metadata: { params, status: err?.response?.status },
    });
    throw new Error(
      err?.response?.data?.message ??
        err?.message ??
        `TCG Price Lookup request failed: ${path}`,
    );
  }
};

export interface TplSearchResult {
  data: Array<{
    id: string;
    name: string;
    set?: { id?: string; name?: string };
    number?: string;
    game?: string;
  }>;
}

/** Search by name, optionally scoped to one game. Game slugs confirmed
 * from their Postman collection: pokemon | mtg | yugioh | lorcana |
 * onepiece | swu | fab | pokemon-jp. */
export const searchCards = async (
  query: string,
  game?: string,
  limit = 10,
): Promise<TplSearchResult> => {
  return tplGet<TplSearchResult>("/cards/search", { q: query, game, limit });
};

/** Full card detail by TCG Price Lookup's own UUID (not a TCGPlayer ID —
 * this vendor uses its own internal card identifiers, confirmed from
 * their Postman collection's example UUID format). Returns the raw
 * response plus a scan for anything grading-shaped in it. */
export const getCardDetail = async (
  id: string,
): Promise<{ raw: unknown; gradingHits: GradingHit[] }> => {
  const raw = await tplGet<unknown>(`/cards/${id}`, {});
  const gradingHits = scanForGradingKeys(raw);
  return { raw, gradingHits };
};

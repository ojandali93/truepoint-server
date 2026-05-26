// src/lib/ebayClient.ts
//
// eBay Browse API client for the arbitrage feature.
//   - Client-credentials OAuth (app token, no user login needed for Browse)
//   - searchListings(query)  → active listing summaries
//   - getListing(itemId)     → full item incl. ALL image URLs
//
// Sandbox vs production is chosen by EBAY_ENV. The Browse API only returns
// ACTIVE listings (not sold) — which is exactly what the arbitrage flow needs
// (deciding what to buy NOW). No Marketplace Insights / sold-data access needed.
//
// Env vars:
//   EBAY_ENV          "sandbox" | "production"   (default "sandbox")
//   EBAY_APP_ID       App ID (Client ID)
//   EBAY_CERT_ID      Cert ID (Client Secret)
//   (DEV_ID is not needed for the Browse API client-credentials flow.)

import axios from "axios";

const ENV = process.env.EBAY_ENV === "production" ? "production" : "sandbox";

const BASE =
  ENV === "production"
    ? "https://api.ebay.com"
    : "https://api.sandbox.ebay.com";

const OAUTH_URL = `${BASE}/identity/v1/oauth2/token`;
const BROWSE_URL = `${BASE}/buy/browse/v1`;

// Browse API scope for client-credentials (app) token
const SCOPE = "https://api.ebay.com/oauth/api_scope";

// ─── Types (only the fields we use) ──────────────────────────────────────────

export interface EbayListingSummary {
  itemId: string;
  title: string;
  price: { value: string; currency: string } | null;
  condition: string | null;
  imageUrl: string | null;
  itemWebUrl: string | null; // "open on eBay" link
}

export interface EbayListingDetail extends EbayListingSummary {
  imageUrls: string[]; // primary + all additional images (for vision)
  description: string | null;
  itemLocation: string | null;
}

// ─── Token cache (client-credentials tokens last ~2h) ────────────────────────

let cachedToken: { token: string; expiresAt: number } | null = null;

const getAppToken = async (): Promise<string> => {
  if (!process.env.EBAY_APP_ID || !process.env.EBAY_CERT_ID) {
    throw { status: 503, message: "eBay API not configured" };
  }
  // reuse cached token until ~1 min before expiry
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token;
  }

  const basic = Buffer.from(
    `${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`,
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    scope: SCOPE,
  });

  const res = await axios.post(OAUTH_URL, body.toString(), {
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    timeout: 20000,
  });

  const token = res.data?.access_token as string;
  const expiresIn = (res.data?.expires_in ?? 7200) as number;
  cachedToken = { token, expiresAt: Date.now() + expiresIn * 1000 };
  return token;
};

// ─── Mappers ─────────────────────────────────────────────────────────────────

const mapSummary = (it: any): EbayListingSummary => ({
  itemId: it.itemId,
  title: it.title ?? "",
  price: it.price
    ? { value: it.price.value, currency: it.price.currency }
    : null,
  condition: it.condition ?? null,
  imageUrl: it.image?.imageUrl ?? it.thumbnailImages?.[0]?.imageUrl ?? null,
  itemWebUrl: it.itemWebUrl ?? null,
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search active listings by keyword (e.g. "mega gengar ex 284").
 * Returns FIXED_PRICE + AUCTION by default. limit caps results (default 20).
 */
// ─── Search filters ──────────────────────────────────────────────────────────
// Extensible filter set. Add new filters here as the feature grows; the builder
// below translates them into eBay Browse API `filter` / `sort` syntax.

export interface SearchFilters {
  // Listing format
  buyItNow?: boolean; // FIXED_PRICE
  auction?: boolean; // AUCTION
  bestOffer?: boolean; // BEST_OFFER
  // Price range (USD)
  minPrice?: number;
  maxPrice?: number;
  // Condition: eBay condition IDs. Common for cards: 1000=New, 4000=VG,
  // 3000=Used. (For TCG, "graded" is an ASPECT, handled separately below.)
  conditionIds?: number[];
  // Graded vs raw. eBay exposes this as a category ASPECT ("Grade"/"Graded"),
  // NOT a top-level filter. true = only graded, false = only raw, undefined = both.
  graded?: boolean;
  // Sort order
  sort?: "best" | "price_asc" | "price_desc" | "newest";
}

// Builds the comma-separated eBay `filter` string from our SearchFilters.
const buildFilterString = (f: SearchFilters): string => {
  const parts: string[] = [];

  // buyingOptions — only add if the user picked a subset (else eBay default)
  const opts: string[] = [];
  if (f.buyItNow) opts.push("FIXED_PRICE");
  if (f.auction) opts.push("AUCTION");
  if (f.bestOffer) opts.push("BEST_OFFER");
  if (opts.length) parts.push(`buyingOptions:{${opts.join("|")}}`);

  // price range — eBay syntax price:[min..max], open-ended ok: [40..] or [..50]
  if (f.minPrice != null || f.maxPrice != null) {
    const lo = f.minPrice != null ? f.minPrice : "";
    const hi = f.maxPrice != null ? f.maxPrice : "";
    parts.push(`price:[${lo}..${hi}],priceCurrency:USD`);
  }

  // condition IDs
  if (f.conditionIds && f.conditionIds.length) {
    parts.push(`conditionIds:{${f.conditionIds.join("|")}}`);
  }

  return parts.join(",");
};

const sortParam = (s?: SearchFilters["sort"]): string | undefined => {
  switch (s) {
    case "price_asc":
      return "price";
    case "price_desc":
      return "-price";
    case "newest":
      return "newlyListed";
    case "best":
    default:
      return undefined; // eBay default = Best Match
  }
};

export const searchListings = async (
  query: string,
  limit = 20,
  filters: SearchFilters = {},
): Promise<EbayListingSummary[]> => {
  const token = await getAppToken();

  // Pokémon TCG category. Required twice when using aspect_filter (graded).
  // EBAY_USE_CATEGORY=false drops it (only needed for sparse sandbox testing).
  const useCategory = process.env.EBAY_USE_CATEGORY !== "false";
  const POKEMON_CATEGORY = "183454";

  const params: Record<string, string | number> = {
    q: query,
    limit,
  };
  if (useCategory) {
    params.category_ids = POKEMON_CATEGORY;
  }

  const filterStr = buildFilterString(filters);
  if (filterStr) params.filter = filterStr;

  const sort = sortParam(filters.sort);
  if (sort) params.sort = sort;

  // Graded vs raw is a category ASPECT, requires aspect_filter + category twice.
  // eBay's TCG aspect for grading is "Grade" (graded cards have a value like
  // "PSA 10"); raw cards typically lack the aspect. We approximate:
  //   graded === true  → require a Grade aspect present (Professional Grader)
  //   graded === false → exclude graded (handled client-side post-filter, since
  //                       "absence of aspect" can't be expressed in aspect_filter)
  // Only graded===true uses aspect_filter; graded===false is filtered after.
  if (filters.graded === true && useCategory) {
    // "Professional Grader" is the common TCG aspect name for graded cards.
    params.aspect_filter = `categoryId:${POKEMON_CATEGORY},Professional Grader:{PSA|BGS|CGC|SGC|TAG}`;
  }

  const res = await axios.get(`${BROWSE_URL}/item_summary/search`, {
    params,
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    timeout: 20000,
  });

  let items: any[] = res.data?.itemSummaries ?? [];

  // graded===false: exclude listings that look graded (title or condition hints).
  // Cheap heuristic since "no grade aspect" isn't expressible server-side.
  if (filters.graded === false) {
    const gradedRe = /\b(psa|bgs|cgc|sgc|tag|graded|gem mt|gem mint)\b/i;
    items = items.filter((it) => !gradedRe.test(it.title ?? ""));
  }

  return items.map(mapSummary);
};

/**
 * Full detail for one listing, including EVERY image URL (primary + additional)
 * — these are what get fed to the Gemini grader.
 */
export const getListing = async (
  itemId: string,
): Promise<EbayListingDetail> => {
  const token = await getAppToken();
  const res = await axios.get(
    `${BROWSE_URL}/item/${encodeURIComponent(itemId)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
      },
      timeout: 20000,
    },
  );

  const it = res.data ?? {};
  const summary = mapSummary(it);

  // Collect primary + additional images, de-duped, https only
  const urls = new Set<string>();
  if (it.image?.imageUrl) urls.add(it.image.imageUrl);
  for (const img of it.additionalImages ?? []) {
    if (img?.imageUrl) urls.add(img.imageUrl);
  }

  return {
    ...summary,
    imageUrls: Array.from(urls).filter((u) => u.startsWith("https")),
    description: it.shortDescription ?? null,
    itemLocation: it.itemLocation?.country ?? null,
  };
};

export const ebayEnv = () => ENV;

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
  seller: string | null;
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
  seller: it.seller?.username ?? null,
});

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Search active listings by keyword (e.g. "mega gengar ex 284").
 * Returns FIXED_PRICE + AUCTION by default. limit caps results (default 20).
 */
export const searchListings = async (
  query: string,
  limit = 20,
): Promise<EbayListingSummary[]> => {
  const token = await getAppToken();
  const res = await axios.get(`${BROWSE_URL}/item_summary/search`, {
    params: {
      q: query,
      limit,
      // include auctions too (default would be FIXED_PRICE only)
      filter: "buyingOptions:{FIXED_PRICE|AUCTION}",
      // Pokémon TCG category (Collectible Card Games) — 183454.
      // Helps relevance; safe to remove if it over-filters in sandbox.
      category_ids: "183454",
    },
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
    timeout: 20000,
  });

  const items = res.data?.itemSummaries ?? [];
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

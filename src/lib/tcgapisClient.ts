// src/lib/tcgapisClient.ts
// TCGAPIs.com — single source of truth for card catalog, variants, and pricing
// Base: https://api.tcgapis.com
// Auth: x-api-key header
// Pokemon categoryId = 3
//
// Docs confirmed endpoints (Unlimited plan):
//   GET /api/v2/expansions/{categoryId}        — sets
//   GET /api/v2/cards/{groupId}                — cards in a set
//   GET /api/v2/prices/{productId}             — product-level (variant) prices
//   GET /api/v1/skuprices/product/{productId}  — ALL SKU prices for a product (one call)
//   GET /api/v1/skuprices/{skuId}              — single SKU price
//   GET /api/v2/sales-history/{productId}      — recent sales
//   GET /api/v2/sales-history/{productId}/full — historic sales archive

import axios from "axios";
import { logError } from "./Logger";

if (!process.env.TCGAPIS_API_KEY) {
  console.warn("[TCGAPIs] TCGAPIS_API_KEY not set");
}

export const tcgapisHttp = axios.create({
  baseURL: "https://api.tcgapis.com",
  headers: {
    "x-api-key": process.env.TCGAPIS_API_KEY ?? "",
    Accept: "application/json",
  },
  timeout: 30000,
});

export const POKEMON_CATEGORY_ID = 3;
export const POKEMON_JP_CATEGORY_ID = 85;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET with retry/backoff. Only logs to error_logs on FINAL failure — not on
 * every transient retry — so the error_logs table stays signal-rich.
 */
export const tcgapisGet = async <T>(
  url: string,
  params?: Record<string, any>,
  retries = 3,
): Promise<T> => {
  let lastErr: any = null;
  for (let i = 0; i < retries; i++) {
    try {
      const res = await tcgapisHttp.get<T>(url, { params });
      return res.data;
    } catch (err: any) {
      lastErr = err;
      const status = err?.response?.status;

      // Rate limited — wait and retry (don't count as a retry attempt burn)
      if (status === 429) {
        await sleep(30000);
        continue;
      }
      // Plan/permission errors are not retryable — fail fast and loud
      if (status === 402 || status === 403) {
        await logError({
          source: "tcgapis-plan-restriction",
          message: `Plan restriction on ${url}: ${err?.response?.data?.error ?? status}`,
          error: err,
          userId: null,
          requestPath: url,
          requestMethod: "GET",
          metadata: { params: params ?? {} },
        });
        throw new Error(
          `Plan restriction: ${err?.response?.data?.error ?? url}`,
        );
      }
      // Transient — backoff and retry
      if (i < retries - 1) {
        await sleep(2000 * (i + 1));
        continue;
      }
    }
  }
  // Final failure — log once
  await logError({
    source: "tcgapis-get",
    message: lastErr?.message ?? `Failed after ${retries} retries: ${url}`,
    error: lastErr,
    userId: null,
    requestPath: url,
    requestMethod: "GET",
    metadata: { params: params ?? {} },
  });
  throw lastErr ?? new Error(`Failed after ${retries} retries: ${url}`);
};

export { sleep };

// ─── Variant name → TruePoint internal mapping ────────────────────────────────

export const VARIANT_MAP: Record<
  string,
  { type: string; label: string; color: string; sortOrder: number }
> = {
  Normal: { type: "normal", label: "Normal", color: "#E5C97E", sortOrder: 0 },
  Holofoil: {
    type: "holofoil",
    label: "Holofoil",
    color: "#9B8EDB",
    sortOrder: 1,
  },
  "Reverse Holofoil": {
    type: "reverseHolofoil",
    label: "Reverse Holo",
    color: "#7BC4E2",
    sortOrder: 2,
  },
  Foil: { type: "holofoil", label: "Holofoil", color: "#9B8EDB", sortOrder: 1 },
  "1st Edition Normal": {
    type: "1stEditionNormal",
    label: "1st Edition",
    color: "#F59E0B",
    sortOrder: 3,
  },
  "1st Edition Holofoil": {
    type: "1stEditionHolofoil",
    label: "1st Ed Holo",
    color: "#C9A84C",
    sortOrder: 4,
  },
  Unlimited: {
    type: "unlimited",
    label: "Unlimited",
    color: "#6B7280",
    sortOrder: 5,
  },
  "Unlimited Holofoil": {
    type: "unlimitedHolofoil",
    label: "Unlimited Holo",
    color: "#8B5CF6",
    sortOrder: 6,
  },
  "Poke Ball Pattern": {
    type: "pokeball",
    label: "Poké Ball",
    color: "#EF4444",
    sortOrder: 2,
  },
  "Master Ball Pattern": {
    type: "masterball",
    label: "Master Ball",
    color: "#6366F1",
    sortOrder: 3,
  },
  "Energy Pattern": {
    type: "energyPattern",
    label: "Energy Pattern",
    color: "#10B981",
    sortOrder: 4,
  },
  "Great Ball Pattern": {
    type: "greatball",
    label: "Great Ball",
    color: "#3B82F6",
    sortOrder: 5,
  },
  "Ultra Ball Pattern": {
    type: "ultraball",
    label: "Ultra Ball",
    color: "#F97316",
    sortOrder: 6,
  },
  "Cosmos Holofoil": {
    type: "cosmosHolofoil",
    label: "Cosmos Holo",
    color: "#A78BFA",
    sortOrder: 7,
  },
  "Cracked Ice Holofoil": {
    type: "crackedIce",
    label: "Cracked Ice",
    color: "#BAE6FD",
    sortOrder: 8,
  },
};

export const resolveVariant = (printing: string) =>
  VARIANT_MAP[printing] ?? {
    type: printing
      .toLowerCase()
      .replace(/\s+/g, "")
      .replace(/[^a-z0-9]/g, ""),
    label: printing,
    color: "#6B7280",
    sortOrder: 99,
  };

// ─── Condition name → internal code ───────────────────────────────────────────
// TCGPlayer condition strings → your inventory.condition enum (NM/LP/MP/HP/DM)

export const CONDITION_CODE: Record<string, string> = {
  "Near Mint": "NM",
  "Lightly Played": "LP",
  "Moderately Played": "MP",
  "Heavily Played": "HP",
  Damaged: "DM",
  // Foil-prefixed variants sometimes append condition; handle common forms
  "Near Mint Foil": "NM",
  "Lightly Played Foil": "LP",
  "Moderately Played Foil": "MP",
  "Heavily Played Foil": "HP",
  "Damaged Foil": "DM",
  // Sealed
  Unopened: "SEALED",
};

export const normalizeCondition = (c?: string | null): string | null => {
  if (!c) return null;
  if (CONDITION_CODE[c]) return CONDITION_CODE[c];
  // Best-effort: take the leading words before "Foil" and map
  const base = c.replace(/\s*Foil$/i, "").trim();
  if (CONDITION_CODE[base]) return CONDITION_CODE[base];
  return c.toUpperCase().slice(0, 2);
};

// ─── SKU price response parsing (defensive) ───────────────────────────────────
// The /skuprices/product/{productId} response shape per docs/marketing:
//   { success, data: { productId, name, set, skus: [ { skuId, condition,
//     printing, edition, language, prices: { lowPrice, midPrice, highPrice,
//     marketPrice, directLowPrice } } ] } }
// Some deployments return { success, data: [ ...skus ] } or { skus: [...] }.
// This normalizer handles all of those.

export interface NormalizedSku {
  skuId: number;
  condition: string | null;
  printing: string | null;
  edition: string | null;
  language: string | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
}

const num = (v: any): number | null =>
  v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v);

export const parseSkuPricesResponse = (raw: any): NormalizedSku[] => {
  // Find the array of SKUs wherever it lives
  const skus =
    raw?.data?.skus ??
    raw?.skus ??
    (Array.isArray(raw?.data) ? raw.data : null) ??
    (Array.isArray(raw) ? raw : null) ??
    [];

  return (skus as any[])
    .map((s) => {
      const prices = s?.prices ?? s ?? {};
      const skuId = num(s?.skuId ?? s?.sku_id ?? s?.skuID);
      if (skuId == null) return null;
      return {
        skuId,
        condition: s?.condition ?? null,
        printing: s?.printing ?? s?.variant ?? null,
        edition: s?.edition ?? null,
        language: s?.language ?? "English",
        lowPrice: num(prices?.lowPrice ?? prices?.low_price ?? prices?.low),
        midPrice: num(prices?.midPrice ?? prices?.mid_price ?? prices?.mid),
        highPrice: num(prices?.highPrice ?? prices?.high_price ?? prices?.high),
        marketPrice: num(
          prices?.marketPrice ?? prices?.market_price ?? prices?.market,
        ),
        directLowPrice: num(prices?.directLowPrice ?? prices?.direct_low_price),
      } as NormalizedSku;
    })
    .filter((x): x is NormalizedSku => x !== null);
};

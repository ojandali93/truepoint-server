// src/lib/ximilarClient.ts
// Ximilar Collectibles Recognition — TCG card identification.
//   POST https://api.ximilar.com/collectibles/v2/tcg_id
//   Header: Authorization: Token <XIMILAR_API_TOKEN>
//   Body:   application/json  { records: [{ _base64: "<base64>" }], rotate: true }
//
// NOTE: tcg_id requires a paid Ximilar plan (Business tier) with Collectibles
// Recognition enabled + available credits. A token alone is not enough — an
// unprovisioned/credit-less token returns HTTP 401/402/403, which previously
// surfaced only as a generic "Request failed with status code XXX". This client
// now extracts Ximilar's status + body into the thrown error so the real reason
// shows up in Error Logs, and also checks Ximilar's per-record status codes.

import axios, { AxiosError } from "axios";

const XIMILAR_TCG_URL = "https://api.ximilar.com/collectibles/v2/tcg_id";

export interface XimilarMatch {
  name?: string;
  full_name?: string;
  set?: string;
  set_code?: string;
  series?: string;
  card_number?: string;
  out_of?: string;
  rarity?: string;
  year?: number | string;
  subcategory?: string;
  links?: Record<string, string>;
  [k: string]: unknown;
}

export interface XimilarIdentification {
  bestMatch: XimilarMatch | null;
  alternatives: XimilarMatch[];
  distance: number | null;
  subcategory: string | null;
  foil: boolean;
}

const EMPTY: XimilarIdentification = {
  bestMatch: null,
  alternatives: [],
  distance: null,
  subcategory: null,
  foil: false,
};

const cleanBase64 = (b64: string): string =>
  b64.replace(/^data:[^;]+;base64,/, "");

export async function identifyCard(
  base64: string,
): Promise<XimilarIdentification> {
  const token = (process.env.XIMILAR_API_TOKEN ?? "").trim();
  if (!token) throw new Error("XIMILAR_API_TOKEN is not configured");

  let res;
  try {
    res = await axios.post(
      XIMILAR_TCG_URL,
      {
        records: [{ _base64: cleanBase64(base64) }],
        rotate: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${token}`,
        },
        timeout: 25000,
        maxBodyLength: Infinity,
        // Don't let axios throw before we can read Ximilar's error body.
        validateStatus: () => true,
      },
    );
  } catch (err) {
    // Network/timeout (no HTTP response at all).
    const ae = err as AxiosError;
    throw new Error(
      `Ximilar request failed (no response): ${ae.code ?? ""} ${ae.message}`.trim(),
    );
  }

  // HTTP-level error from Ximilar (auth / plan / credits / bad request).
  if (res.status < 200 || res.status >= 300) {
    const body =
      typeof res.data === "string"
        ? res.data
        : JSON.stringify(res.data ?? {});
    throw new Error(
      `Ximilar API error (HTTP ${res.status}): ${body.slice(0, 500)}`,
    );
  }

  // Top-level processing status (Ximilar can return 200 with a non-200 status).
  const topStatus = res.data?.status;
  if (topStatus && typeof topStatus.code === "number" && topStatus.code >= 300) {
    throw new Error(
      `Ximilar processing error (${topStatus.code}): ${topStatus.text ?? "unknown"}`,
    );
  }

  const record = res.data?.records?.[0];
  if (!record) return EMPTY;

  // Per-record status (e.g. image decode failure, credit issue on that record).
  const recStatus = record._status;
  if (recStatus && typeof recStatus.code === "number" && recStatus.code >= 300) {
    throw new Error(
      `Ximilar record error (${recStatus.code}): ${recStatus.text ?? "unknown"}`,
    );
  }

  const objects: any[] = Array.isArray(record._objects) ? record._objects : [];
  const cardObj =
    objects.find((o) => o?.name === "Card") ??
    objects.find((o) => o?.["Top Category"]?.[0]?.name === "Card") ??
    null;

  if (!cardObj) return EMPTY;

  const ident = cardObj._identification ?? {};
  const bestMatch: XimilarMatch | null = ident.best_match ?? null;
  const alternatives: XimilarMatch[] = Array.isArray(ident.alternatives)
    ? ident.alternatives
    : [];
  const distance: number | null = Array.isArray(ident.distances)
    ? (ident.distances[0] ?? null)
    : null;

  const tags = cardObj._tags ?? {};
  const subcategory: string | null =
    tags?.Subcategory?.[0]?.name ?? bestMatch?.subcategory ?? null;
  const foil = String(tags?.["Foil/Holo"]?.[0]?.name ?? "")
    .toLowerCase()
    .includes("foil");

  return { bestMatch, alternatives, distance, subcategory, foil };
}
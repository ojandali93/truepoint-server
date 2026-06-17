// src/lib/ximilarClient.ts
// Ximilar Collectibles Recognition — TCG card identification.
//   POST https://api.ximilar.com/collectibles/v2/tcg_id
//   Header: Authorization: Token <XIMILAR_API_TOKEN>
//   Body:   application/json  { records: [{ _base64: "<base64>" }], rotate: true }
//   Resp:   { records: [{ _objects: [{ name:"Card", _identification:{ best_match, alternatives, distances }, _tags }, ...] }], status }
//
// Unlike CardSight, Ximilar returns a direct TCGPlayer product link in
// best_match.links["tcgplayer.com"] (e.g. .../product/84606). Since our cards.id
// IS the TCGPlayer product id, scan.service can match exactly off that link
// instead of fuzzy name+number+set scoring. We normalize the response down to a
// single best card (+ alternatives) here; scan.service does the catalog match.
//
// Cost note: tcg_id consumes Ximilar credits per call. We do NOT enable
// price_stats / slab_id / slab_grade (each costs extra) — only `rotate` for
// orientation correction. Set XIMILAR_API_TOKEN in env.

import axios from "axios";

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
  subcategory?: string; // "Pokemon", "Magic The Gathering", ...
  links?: Record<string, string>; // { "tcgplayer.com": "...", "ebay.com": "..." }
  [k: string]: unknown;
}

export interface XimilarIdentification {
  bestMatch: XimilarMatch | null;
  alternatives: XimilarMatch[];
  distance: number | null; // distances[0] — lower = more confident
  subcategory: string | null; // from _tags.Subcategory
  foil: boolean; // from _tags."Foil/Holo"
}

const EMPTY: XimilarIdentification = {
  bestMatch: null,
  alternatives: [],
  distance: null,
  subcategory: null,
  foil: false,
};

// Strip a data-URI prefix if the caller sent one; Ximilar wants raw base64.
const cleanBase64 = (b64: string): string =>
  b64.replace(/^data:[^;]+;base64,/, "");

export async function identifyCard(
  base64: string,
): Promise<XimilarIdentification> {
  const token = (process.env.XIMILAR_API_TOKEN ?? "").trim();
  if (!token) throw new Error("XIMILAR_API_TOKEN is not configured");

  const res = await axios.post(
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
    },
  );

  const record = res.data?.records?.[0];
  if (!record) return EMPTY;

  const objects: any[] = Array.isArray(record._objects) ? record._objects : [];

  // Pick the Card object (ignore any Slab Label object).
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

// src/services/scan.service.ts
// Turns a Ximilar identification into one of OUR cards.
//
// Ximilar's tcg_id returns the best-matching card with a direct TCGPlayer
// product link (best_match.links["tcgplayer.com"] = .../product/<id>). Because
// our cards.id IS String(tcgplayerProductId), we match EXACTLY off that id — no
// fuzzy scoring needed. Only if the link is missing or the id isn't in our
// catalog do we fall back to the old name + number + set scoring. The result is
// returned in the same shape getCardById uses so the mobile add-to-inventory
// flow consumes it directly. If nothing matches we still return what Ximilar
// read (card=null) and the app routes the user to manual search.

import { supabaseAdmin } from "../lib/supabase";
import { identifyCard, type XimilarMatch } from "../lib/ximilarClient";

export interface ScanIdentified {
  name: string | null;
  set: string | null;
  number: string | null;
}
export interface ScanMatchedCard {
  id: string;
  name: string;
  number: string;
  rarity: string | null;
  image_small: string | null;
  image_large: string | null;
  language: string | null;
  set: { id: string; name: string };
}
export interface ScanResult {
  confidence: string | null; // visual confidence: High | Medium | Low
  matchConfidence: "high" | "low"; // our DB-match confidence
  identified: ScanIdentified; // what Ximilar read (for display / fallback)
  card: ScanMatchedCard | null; // our catalog card, or null → manual search
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Collector numbers vary ("6", "006", "6/102", "SVP-001"); compare the part
// before any "/", strip leading zeros and punctuation.
const normNum = (s: string | null | undefined) =>
  (s ?? "")
    .toLowerCase()
    .split("/")[0]
    .replace(/[^a-z0-9]/g, "")
    .replace(/^0+(?=.)/, "");

interface CardRow {
  id: string;
  name: string;
  number: string;
  rarity: string | null;
  set_id: string;
  image_small: string | null;
  image_large: string | null;
  language: string | null;
  sets?: { name?: string | null; language?: string | null } | null;
}

const CARD_SELECT =
  "id, name, number, rarity, set_id, image_small, image_large, language, sets(name, language)";

const toMatchedCard = (c: CardRow): ScanMatchedCard => ({
  id: c.id,
  name: c.name,
  number: c.number,
  rarity: c.rarity,
  image_small: c.image_small,
  image_large: c.image_large,
  language: c.language,
  set: { id: c.set_id, name: c.sets?.name ?? c.set_id },
});

// ─── Exact match via TCGPlayer product id ─────────────────────────────────────

// best_match.links can be { "tcgplayer.com": "https://www.tcgplayer.com/product/84606", ... }
const TCGPLAYER_ID_RE = /tcgplayer\.com\/product\/(\d+)/i;

const tcgplayerIdFromLinks = (
  links: Record<string, string> | undefined,
): string | null => {
  for (const v of Object.values(links ?? {})) {
    const m = String(v).match(TCGPLAYER_ID_RE);
    if (m) return m[1];
  }
  return null;
};

async function fetchCardById(id: string): Promise<ScanMatchedCard | null> {
  const { data } = await supabaseAdmin
    .from("cards")
    .select(CARD_SELECT)
    .eq("id", id)
    .maybeSingle();
  return data ? toMatchedCard(data as CardRow) : null;
}

// ─── Fuzzy fallback (name + number + set) ─────────────────────────────────────

async function matchCard(
  name: string,
  setName: string,
  number: string,
  preferLanguage: string = "English",
): Promise<{ card: ScanMatchedCard | null; matchConfidence: "high" | "low" }> {
  // Primary: candidates by card name (most reliable signal).
  let { data } = await supabaseAdmin
    .from("cards")
    .select(CARD_SELECT)
    .ilike("name", `%${name}%`)
    .limit(100);
  let candidates = (data ?? null) as CardRow[] | null;

  // Fallback: by exact number if name found nothing.
  if ((!candidates || candidates.length === 0) && number) {
    const r = await supabaseAdmin
      .from("cards")
      .select(CARD_SELECT)
      .eq("number", number)
      .limit(100);
    candidates = r.data as CardRow[] | null;
  }

  const rows = candidates ?? [];
  if (rows.length === 0) return { card: null, matchConfidence: "low" };

  const wantName = norm(name);
  const wantNum = normNum(number);
  const wantSet = norm(setName);

  let best: CardRow | null = null;
  let bestScore = -1;
  let bestNumMatched = false;
  let bestSetMatched = false;

  for (const c of rows) {
    let score = 0;

    const cName = norm(c.name);
    if (cName === wantName) score += 2;
    else if (cName.includes(wantName) || wantName.includes(cName)) score += 1;

    const cNum = normNum(c.number);
    const numMatched = !!wantNum && !!cNum && cNum === wantNum;
    if (numMatched) score += 3;

    const cSet = norm(c.sets?.name);
    const setMatched =
      !!wantSet &&
      !!cSet &&
      (cSet === wantSet || cSet.includes(wantSet) || wantSet.includes(cSet));
    if (setMatched) score += 2;

    // Language preference: break ties toward the language being scanned
    // (default English). Small weight so it only decides otherwise-equal
    // matches — it won't override a strong number/set match for a genuine
    // Japanese scan. Stops English scans resolving to the JP printing now
    // that Japanese sets are in the catalog.
    if (preferLanguage && c.language === preferLanguage) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = c;
      bestNumMatched = numMatched;
      bestSetMatched = setMatched;
    }
  }

  if (!best) return { card: null, matchConfidence: "low" };

  // High confidence when the number matches AND the set matches (or there's
  // only one candidate). Otherwise we surface it but flag for review.
  const matchConfidence: "high" | "low" =
    bestNumMatched && (bestSetMatched || rows.length === 1) ? "high" : "low";

  return { card: toMatchedCard(best), matchConfidence };
}

// ─── Visual confidence from Ximilar distance ──────────────────────────────────

const confidenceFromDistance = (d: number | null): string => {
  if (d == null) return "Low";
  if (d <= 0.35) return "High";
  if (d <= 0.55) return "Medium";
  return "Low";
};

// ─── Entry point ──────────────────────────────────────────────────────────────

export async function identifyAndMatch(
  base64: string,
  _mime: string, // accepted for controller compatibility; Ximilar needs only base64
): Promise<ScanResult[]> {
  const ident = await identifyCard(base64);
  const bm: XimilarMatch | null = ident.bestMatch;

  // Nothing recognized → empty result; app shows "no match / search manually".
  if (!bm) return [];

  const name = bm.name ?? bm.full_name ?? null;
  const set = bm.set ?? null;
  const number = bm.card_number ?? null;

  let card: ScanMatchedCard | null = null;
  let matchConfidence: "high" | "low" = "low";

  // 1) EXACT: TCGPlayer product id from the link === our cards.id.
  const tcgId = tcgplayerIdFromLinks(bm.links);
  if (tcgId) {
    card = await fetchCardById(tcgId);
    if (card) matchConfidence = "high";
  }

  // 2) FALLBACK: fuzzy name + number + set (e.g. link missing, or JP card whose
  //    TCGPlayer id maps to the English product rather than our JP catalog row).
  if (!card && name) {
    const m = await matchCard(name, set ?? "", number ?? "");
    card = m.card;
    matchConfidence = m.matchConfidence;
  }

  return [
    {
      confidence: confidenceFromDistance(ident.distance),
      matchConfidence,
      identified: { name, set, number },
      card,
    },
  ];
}

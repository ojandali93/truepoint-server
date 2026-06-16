// src/services/scan.service.ts
// Turns a CardSight identification into one of OUR cards.
//
// CardSight gives name + releaseName (set) + number but no TCGPlayer id, so we
// match against the cards table (joined to sets) by scoring name + number + set
// overlap. The best candidate is returned in the same shape getCardById uses, so
// the mobile add-to-inventory flow can consume it directly. If nothing matches
// confidently we still return what CardSight read, with card=null, and the app
// routes the user to manual search.

import { supabaseAdmin } from "../lib/supabase";
import { identifyCard } from "../lib/cardsightClient";

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
  confidence: string | null; // CardSight visual confidence: High | Medium | Low
  matchConfidence: "high" | "low"; // our DB-match confidence
  identified: ScanIdentified; // what CardSight read (for display / fallback)
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

async function matchCard(
  name: string,
  setName: string,
  number: string,
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
    candidates = (r.data ?? null) as CardRow[] | null;
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

export async function identifyAndMatch(
  base64: string,
  mime: string,
): Promise<ScanResult[]> {
  const resp = await identifyCard(base64, mime);
  const detections = resp.detections ?? [];

  const results: ScanResult[] = [];
  for (const d of detections) {
    const name = d.card?.name ?? null;
    const set = d.card?.releaseName ?? null;
    const number = d.card?.number ?? null;

    let matched: { card: ScanMatchedCard | null; matchConfidence: "high" | "low" } =
      { card: null, matchConfidence: "low" };
    if (name) matched = await matchCard(name, set ?? "", number ?? "");

    results.push({
      confidence: d.confidence ?? null,
      matchConfidence: matched.matchConfidence,
      identified: { name, set, number },
      card: matched.card,
    });
  }
  return results;
}
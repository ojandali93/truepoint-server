import {
  GoogleGenerativeAI,
  Part,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";
import { logError } from "./Logger";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? "");

// ─── Card Identification ──────────────────────────────────────────────────────

export interface CardIdentificationResult {
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  hp: string | null;
  rarity: string | null;
  supertype: string | null;
  confidence: "high" | "medium" | "low";
  rawResponse: string;
}

const CARD_ID_PROMPT = `You are a Pokémon TCG card identification expert. Analyze this card image and extract the following details. Respond ONLY in valid JSON with no extra text, no markdown, no code blocks.

Extract:
- cardName: the name printed on the card (e.g. "Charizard ex", "Professor's Research")
- setName: the set name or series (e.g. "Obsidian Flames", "Base Set")
- cardNumber: the card number printed at the bottom (e.g. "125/197", "GG69", "SWSH001")
- hp: the HP value if it's a Pokémon card (e.g. "330"), null for non-Pokémon
- rarity: the rarity symbol description (e.g. "Common", "Rare Holo", "Ultra Rare", "Special Illustration Rare")
- supertype: one of "Pokémon", "Trainer", or "Energy"
- confidence: "high" if all fields are clearly visible, "medium" if some are unclear, "low" if the image is poor quality

Return exactly this shape:
{"cardName":null,"setName":null,"cardNumber":null,"hp":null,"rarity":null,"supertype":null,"confidence":"low"}`;

const fileToGenerativePart = (base64Data: string, mimeType: string): Part => ({
  inlineData: { data: base64Data, mimeType },
});

export const identifyCardFromBase64 = async (
  base64Image: string,
  mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg",
): Promise<CardIdentificationResult> => {
  if (!process.env.GEMINI_API_KEY) {
    throw { status: 503, message: "Gemini Vision API not configured" };
  }

  const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
  const imagePart = fileToGenerativePart(base64Image, mimeType);
  const result = await model.generateContent([CARD_ID_PROMPT, imagePart]);
  const rawResponse = result.response.text().trim();

  try {
    const clean = rawResponse.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean) as CardIdentificationResult;
    parsed.rawResponse = rawResponse;
    return parsed;
  } catch {
    return {
      cardName: null,
      setName: null,
      cardNumber: null,
      hp: null,
      rarity: null,
      supertype: null,
      confidence: "low",
      rawResponse,
    };
  }
};

export const identifyCardFromUrl = async (
  imageUrl: string,
): Promise<CardIdentificationResult> => {
  if (!process.env.GEMINI_API_KEY) {
    throw { status: 503, message: "Gemini Vision API not configured" };
  }

  const axiosLib = await import("axios");
  const response = await axiosLib.default.get(imageUrl, {
    responseType: "arraybuffer",
  });
  const base64 = Buffer.from(response.data).toString("base64");
  const contentType = response.headers["content-type"] ?? "image/jpeg";

  return identifyCardFromBase64(base64, contentType as any);
};

// ─── AI Grading ───────────────────────────────────────────────────────────────
//
// Two-stage design:
//   1. Gemini scores intrinsic quality 0–100 across four sub-dimensions (front
//      + back). It is told NOT to output a company grade — the 0–100 scale
//      stops it anchoring to the modal real grade (was clustering at 9).
//   2. We compute one objective TP Score (0–100) in code, then round/adjust it
//      to each company's mold: PSA -> nearest whole; BGS/CGC/TAG -> nearest 0.5.

export interface SubScores {
  centering: number; // 0–100
  corners: number; // 0–100
  edges: number; // 0–100
  surface: number; // 0–100
}

/** One face's (front or back) independent sub-dimension scores. */
export interface FaceScores {
  centering: number; // 0–100
  corners: number; // 0–100
  edges: number; // 0–100
  surface: number; // 0–100
}

/** Structured detail stored on ai_grading_reports.report (simplified from v2). */
export interface ObjectiveReport {
  sub: SubScores;
  centering: { front: string; back: string | null };
  overallConfidence: number;
  strengths: string[];
  issues: string[];
  notes: string;
}

export interface GradingAnalysis {
  tpScore: number; // 0–100 objective score (this is the canonical TP score)
  tpDisplay: number; // tpScore / 10, one decimal (e.g. 9.6) — convenience for UI
  sub: SubScores; // 0–100 each
  report: ObjectiveReport;
  predictions: {
    psa: { grade: number; label: string };
    bgs: { grade: number; label: string; isBlackLabel: boolean };
    cgc: { grade: number; label: string; isPristine: boolean };
    tag: {
      grade: number;
      label: string;
      isPristine: boolean;
      score1000: number;
    };
  };
  centeringRatio: { front: string; back: string | null };
  issues: string[];
  strengths: string[];
  confidence: number; // 0–100
  notes: string;
}

// ─── TP Score computation ─────────────────────────────────────────────────────
// Weighted average blended toward the WEAKEST sub-dimension. Tune freely.

const WEIGHTS = { centering: 0.3, surface: 0.28, corners: 0.22, edges: 0.2 };
const MIN_WEIGHT = 0.25; // how hard the weakest sub-dimension drags the score down

const clamp100 = (v: number) => Math.max(1, Math.min(100, Math.round(v)));

export function computeTpScore(s: SubScores): number {
  const weighted =
    s.centering * WEIGHTS.centering +
    s.surface * WEIGHTS.surface +
    s.corners * WEIGHTS.corners +
    s.edges * WEIGHTS.edges;
  const min = Math.min(s.centering, s.corners, s.edges, s.surface);
  const tp = weighted * (1 - MIN_WEIGHT) + min * MIN_WEIGHT;
  return clamp100(tp);
}

// ─── TP Score → company predictions ───────────────────────────────────────────

const clamp10 = (x: number) => Math.max(1, Math.min(10, x));
const toHalf = (x: number) => clamp10(Math.round(x * 2) / 2); // nearest 0.5
const toWhole = (x: number) => clamp10(Math.round(x)); // nearest integer
const fmtGrade = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);

const PSA_NAMES: Record<number, string> = {
  10: "Gem Mint",
  9: "Mint",
  8: "Near Mint-Mint",
  7: "Near Mint",
  6: "Excellent-Mint",
  5: "Excellent",
  4: "Very Good-Excellent",
  3: "Very Good",
  2: "Good",
  1: "Poor",
};

const tierName = (grade: number): string => {
  if (grade >= 10) return "Pristine";
  if (grade >= 9.5) return "Gem Mint";
  if (grade >= 9) return "Mint";
  if (grade >= 8.5) return "Near Mint-Mint+";
  if (grade >= 8) return "Near Mint-Mint";
  if (grade >= 7) return "Near Mint";
  return "";
};

// ─── Centering → per-company grade ceilings ───────────────────────────────────
//
// Centering is a HARD GATE, not an average: PSA and BGS apply very different
// tolerances to the same card, so a single blended score can't represent both.
// Measured as the larger border over the total of both borders, per axis; the
// worst of the two axes governs.
//
//   PSA  10: front 55/45–60/40   · back up to 75/25 (back is loose)
//   PSA   9: front ~65/35
//   PSA   8: front ~70/30
//   BGS  10: front 50/50         · back 55/45      (Black Label)
//   BGS 9.5: front 55/45         · back 60/40
//   BGS   9: front 60/40         · back 65/35

/** Larger side of the worst axis from ratio strings like "60/40". */
function worstAxisPct(lr?: string | null, tb?: string | null): number {
  const larger = (s?: string | null): number => {
    const parts = String(s ?? "")
      .split("/")
      .map((n) => parseFloat(n))
      .filter((n) => Number.isFinite(n));
    if (parts.length !== 2) return 50;
    return Math.max(parts[0], parts[1]);
  };
  return Math.max(larger(lr), larger(tb));
}

/** PSA whole-grade ceiling from centering. Front strict, back lenient. */
function psaCenteringCeiling(front: number, back: number): number {
  const f =
    front <= 60
      ? 10 // PSA allows up to 60/40 on the front for a Gem Mint 10
      : front <= 65
        ? 9
        : front <= 70
          ? 8
          : front <= 75
            ? 7
            : front <= 80
              ? 6
              : 5;
  const b =
    back <= 75
      ? 10 // PSA back tolerance is 75/25 even at the top grade
      : back <= 85
        ? 9
        : back <= 90
          ? 8
          : 7;
  return Math.min(f, b);
}

/** BGS CENTERING SUBGRADE (0.5 scale) — much stricter than PSA. */
function bgsCenteringSubgrade(front: number, back: number): number {
  const f =
    front <= 50
      ? 10
      : front <= 55
        ? 9.5
        : front <= 60
          ? 9
          : front <= 65
            ? 8.5
            : front <= 70
              ? 8
              : 7;
  const b =
    back <= 55
      ? 10
      : back <= 60
        ? 9.5
        : back <= 65
          ? 9
          : back <= 70
            ? 8.5
            : back <= 75
              ? 8
              : 7;
  return Math.min(f, b);
}

/**
 * TAG centering (TCG tolerances) → grade tier + Pristine eligibility.
 * Front is strict, back is very loose. BOTH must clear a tier.
 *   Pristine 10 (990–1000): front ~51/49 · back ~52/48
 *   Gem Mint 10 (950–989):  front ~55/45 · back ~65/35
 *   Mint 9      (900–949):  front ~60/40 · back ~75/25
 *   NM-MT+ 8.5  (850–899):  front ~62.5  · back ~85/15
 *   NM-MT 8     (800–849):  front ~65/35 · back ~95/5
 */
function tagCenteringTcg(
  front: number,
  back: number,
): { ceiling: number; pristineEligible: boolean } {
  const PRISTINE = 10.5; // sentinel above 10 = Pristine-eligible
  const f =
    front <= 51
      ? PRISTINE
      : front <= 55
        ? 10
        : front <= 60
          ? 9
          : front <= 62.5
            ? 8.5
            : front <= 65
              ? 8
              : 7;
  const b =
    back <= 52
      ? PRISTINE
      : back <= 65
        ? 10
        : back <= 75
          ? 9
          : back <= 85
            ? 8.5
            : back <= 95
              ? 8
              : 7;
  const tier = Math.min(f, b);
  return { ceiling: Math.min(10, tier), pristineEligible: tier >= PRISTINE };
}

/**
 * Condition score EXCLUDING centering, for a single face's corners/edges/
 * surface. Shared by the overall blend below and by the worst-face-cap
 * calculation, which needs this same formula applied to ONE face at a time.
 */
function faceCondition(f: { corners: number; edges: number; surface: number }): number {
  const weighted = f.surface * 0.4 + f.corners * 0.32 + f.edges * 0.28;
  const min = Math.min(f.corners, f.edges, f.surface);
  return clamp100(weighted * 0.75 + min * 0.25);
}

export function mapTpScore(
  _tpScore: number,
  sub: SubScores,
  centering?: { front?: string | null; back?: string | null },
  faces?: { front: FaceScores; back: FaceScores },
) {
  // Condition score EXCLUDING centering. Centering is applied separately as a
  // per-company ceiling (below) rather than averaged in — otherwise a card that
  // PSA would still gem (e.g. 60/40 front) gets silently dragged below a 10 by
  // the blend, which is exactly why good cards were under-predicting.
  const condWeighted =
    (sub.surface * 0.4 + sub.corners * 0.32 + sub.edges * 0.28) / 1;
  const condMin = Math.min(sub.corners, sub.edges, sub.surface);
  const condition = clamp100(condWeighted * 0.75 + condMin * 0.25);
  let g = condition / 10; // grade-equivalent from condition alone

  // ─── Worst-face cap (mirrors PSA's effective capping) ───────────────────
  // sub.{corners,edges,surface} is already the WORSE of front/back per
  // category (see analyzeCardForGrading), so a clean front can't dilute a
  // damaged back in the blend above. This is an explicit second layer on
  // top of that: overall can never exceed the back's own condition-only
  // grade by more than 1, and never exceed the single worst individual
  // subgrade (either face, any of corners/edges/surface) by more than 1.5.
  if (faces) {
    const backG = faceCondition(faces.back) / 10;
    const worstSubgradeG =
      Math.min(
        faces.front.corners,
        faces.front.edges,
        faces.front.surface,
        faces.back.corners,
        faces.back.edges,
        faces.back.surface,
      ) / 10;
    g = Math.min(g, backG + 1, worstSubgradeG + 1.5);
  }
  // condition, rescaled to reflect any worst-face cap above — TAG's 1000-pt
  // banding reads this, not the raw uncapped `condition`, so a capped grade
  // can't land on a score1000 that implies a higher tier than the grade it's
  // attached to.
  const cappedCondition = g * 10;

  const frontPct = worstAxisPct(centering?.front, centering?.front);
  const backPct = centering?.back
    ? worstAxisPct(centering.back, centering.back)
    : 50;

  const allGem = Math.min(sub.corners, sub.edges, sub.surface) >= 99;

  // PSA — whole grades, capped by PSA's centering tolerance.
  const psaCeil = psaCenteringCeiling(frontPct, backPct);
  const psaGrade = clamp10(Math.min(toWhole(g), psaCeil));
  const psa = {
    grade: psaGrade,
    label: `PSA ${psaGrade} ${PSA_NAMES[psaGrade] ?? ""}`.trim(),
    centeringCeiling: psaCeil,
  };

  // BGS — half grades. The centering SUBGRADE is strict; the overall grade can
  // sit up to half a point above a single weak subgrade.
  const bgsCentSub = bgsCenteringSubgrade(frontPct, backPct);
  const bgsCeil = Math.min(10, bgsCentSub + 0.5);
  const bgsGrade = clamp10(Math.min(toHalf(g), bgsCeil));
  const bgsBlack = allGem && bgsCentSub >= 10 && bgsGrade >= 10;
  const bgs = {
    grade: bgsGrade,
    label: bgsBlack
      ? "BGS 10 Black Label"
      : `BGS ${fmtGrade(bgsGrade)} ${tierName(bgsGrade)}`.trim(),
    isBlackLabel: bgsBlack,
    centeringSubgrade: bgsCentSub,
  };

  // CGC — PSA-like scale, half grades; Pristine 10 needs near-perfect centering.
  const cgcCeil = psaCeil;
  const cgcGrade = clamp10(Math.min(toHalf(g), cgcCeil));
  const cgcPristine =
    allGem && frontPct <= 55 && backPct <= 60 && cgcGrade >= 10;
  const cgc = {
    grade: cgcGrade,
    label: cgcPristine
      ? "CGC Pristine 10"
      : `CGC ${fmtGrade(cgcGrade)} ${tierName(cgcGrade)}`.trim(),
    isPristine: cgcPristine,
  };

  // TAG — TCG centering tolerances (front strict, back loose) + 1000-pt bands.
  const tagCent = tagCenteringTcg(frontPct, backPct);
  const tagGrade = clamp10(Math.min(toHalf(g), tagCent.ceiling));
  // Pristine also requires a flawless card, not just flawless centering.
  const tagPristine = allGem && tagCent.pristineEligible && tagGrade >= 10;
  // Map the grade onto TAG's published 1000-pt bands.
  const tagScore1000 = tagPristine
    ? 990 + Math.round((Math.min(cappedCondition, 100) - 99) * 10) // 990–1000
    : tagGrade >= 10
      ? 950 + Math.round(Math.min(39, Math.max(0, cappedCondition - 96) * 13)) // 950–989
      : tagGrade >= 9
        ? 900 + Math.round(Math.min(49, Math.max(0, cappedCondition - 90) * 8)) // 900–949
        : tagGrade >= 8.5
          ? 850 +
            Math.round(Math.min(49, Math.max(0, cappedCondition - 85) * 9)) // 850–899
          : tagGrade >= 8
            ? 800 +
              Math.round(Math.min(49, Math.max(0, cappedCondition - 80) * 9)) // 800–849
            : Math.max(100, Math.round(tagGrade * 100));
  const tag = {
    grade: tagGrade,
    label: tagPristine
      ? "TAG 10 Pristine"
      : `TAG ${fmtGrade(tagGrade)} ${tierName(tagGrade)}`.trim(),
    isPristine: tagPristine,
    score1000: Math.max(100, Math.min(1000, tagScore1000)),
  };

  return { psa, bgs, cgc, tag };
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

const GRADING_PROMPT = (
  cardContext: string,
) => `You are a professional trading-card condition grader, held to the same standard as a PSA, BGS, or CGC human grader. You are given the FRONT image and the BACK image of a single Pokémon TCG card.${cardContext ? " " + cardContext : ""}

Score the card's intrinsic physical quality on a 0–100 scale. This is NOT a PSA/BGS/CGC/TAG grade — DO NOT output any company grade. Score raw quality so it can be mapped to grades afterward.

CALIBRATION: most collectors overestimate their own cards' condition — published data shows most raw cards submitted for grading come back lower than the submitter expected. Look closely at each of the four areas below before deciding there's nothing there. But this cuts both ways: a card with only a tiny, genuinely trivial imperfection is still a mint-tier card — don't manufacture significance out of something real grading would treat as negligible. The goal is accuracy in both directions, not a thumb on the scale toward either high or low.

ANTI-ANCHOR — read this before you score anything: a score in the 70–89 range (roughly a 7–8 grade-equivalent) is NOT a safe default or a "reasonable middle" to land on when you're unsure. It is a specific, strong claim — that BOTH faces show near-mint edges and corners with at most trivial wear. That claim needs to be justified by what you actually enumerate below, the same way a 96+ does. If your enumerated findings show whitening on multiple edges or a soft/fuzzed corner, the score must reflect that — do not round back up toward 7–8 out of caution. Under-grading a genuinely clean card is also wrong; the anti-anchor cuts against defaulting in EITHER direction, but a 7–8 in particular is the laziest wrong answer because it "sounds about right" for a used card — it must be earned, not assumed.

This also applies at the individual-finding level, not just the overall score: describing four separate findings as "very minor" or "~10%" each and then still landing near 90 is the SAME anchoring mistake in miniature — you've let each finding's individual mildness talk you out of the compounding effect of there being four of them. The corners/edges count-based ceilings below exist specifically to stop this: once you've enumerated whitening on 3+ edges or wear on 2+ corners, the ceiling applies even if every single instance you wrote down was mild. Mild-times-many is not the same defect as mild-times-one, and the ceiling — not your overall gut impression — is what decides the score at that point.

GRADE FRONT AND BACK INDEPENDENTLY. Do the full four-dimension assessment (centering, corners, edges, surface) once for the FRONT, then again for the BACK, as two separate passes. Do not let a strong front pull up a weak back, or vice versa — a card is only as good as its worse side, which is exactly why the two faces are scored separately below rather than blended into one impression. For EACH of the four sub-dimensions, on EACH face, write out your specific findings FIRST, then assign the 0–100 number for that face+dimension based on what you just wrote — never pick a number first and rationalize it afterward. The JSON schema below lists a "_findings" field immediately before its matching number for this reason; fill them in that order.

- centering (per face): MEASURE IT, don't guess. Compare the two opposite borders on each axis: ratio = (wider border ÷ combined width) × 100. Do this LEFT-TO-RIGHT and TOP-TO-BOTTOM and report the WORST axis as this face's centering_ratio (e.g. left border 3mm, right 2mm → 3/(3+2) = 60 → "60/40"). Report 50/50 only if it truly is. For the 0-100 score: 50/50 ≈ 100; 55/45 ≈ 92; 60/40 ≈ 84; 65/35 ≈ 74; 70/30 ≈ 64; worse scales down further.

- corners (per face): Examine all 4 corners of THIS face individually — a per-corner check, not a general impression. Write one finding per corner (e.g. "top-left: sharp", "bottom-right: soft/fuzzed, visible fraying"). These anchors are a HARD CEILING, not a suggestion — apply them by counting affected corners, even if each one individually looks minor: 0 corners with any fraying/softness/whitening → 90+; exactly 1 → at most 70; 2–3 → at most 50; ALL 4 corners showing any fraying/softness/whitening, even lightly → at most 35; heavy fraying/rounding on any single corner → at most 30, regardless of the others. Do not let "each one is only slight" talk you out of the count-based ceiling — affecting every corner, even lightly, is worse than affecting some of them, which is worse than affecting one; grade the count, not the average severity.

- edges (per face): Examine all 4 edges of THIS face individually. Write one finding per edge naming what you see and roughly how much of the edge's length is affected (e.g. "left edge: whitening along ~60% of length", "top edge: clean"). Whitening on a BACK edge along a dark/colored border is DAMAGE (worn ink/coating exposing the white card stock underneath), not glare or a lighting artifact — treat it as damage unless it is clearly a reflection (a soft, angled highlight that moves with the light source, not a hard-edged line following the border itself). When you genuinely can't tell which it is, grade the damage interpretation — a false "clean" reads worse to a collector than a false "worn" does. These anchors are a HARD CEILING, not a suggestion — apply them by counting affected edges, even if each one individually looks faint or minor: no whitening anywhere → 90+; whitening visible on exactly 1–2 edges, light → 60–80; visible whitening on exactly 3 edges, no matter how faint any single one is → at most 50; whitening on ALL 4 edges, even lightly → at most 35; heavy or continuous whitening on any edge → at most 30, regardless of how the other edges look. Do not let "each one is only ~10%" or "very minor" reasoning talk you out of the count-based ceiling — a card with light whitening touching every edge is worse than one with the same light whitening on just a few, because it means the whole card was handled roughly, not just bumped once; grade the count, not the average severity.

BEFORE you apply either count-based ceiling above: the count is only as honest as the individual findings that feed it. Most real corners and edges, on most real cards, are genuinely clean — "clean" is the ordinary, expected finding for a corner or edge, not a suspicious gap in your enumeration, and it is completely normal for a card to have ZERO real defects on a face. Only mark a corner or edge as affected if you can point to something actually visible there — a real change in the corner's silhouette, a real light-colored line or patch along the edge — that you'd stand behind under closer inspection. Do NOT round out the tally to 3 or 4 out of a sense that the other corners/edges must match once you've found one or two real ones, and do not treat routine photo artifacts (glare, a slightly soft-focus corner, JPEG compression noise, the card's own lighter cardstock edge that's the same on every card of its kind) as whitening. A face with 1 genuine defect and 3 genuinely clean corners/edges must be scored as 1-affected, not padded toward a rounder-sounding count. Fabricating a matching set of findings to "complete the pattern" is exactly the anchoring error the rest of this prompt is trying to eliminate, just running in the opposite direction.

It is completely fine — and often the correct answer — to write "clean" for all 4 corners or all 4 edges of a face, using that exact same word four times. That is not a lazy or suspicious answer; it is what a genuinely undamaged face looks like, and it should be your default unless something specific stops you. Do not manufacture variety across the 4 findings for its own sake (e.g. calling one corner "sharp," another "a faint speck," another "very slightly soft") when what you're actually looking at is four equally clean corners. If you notice yourself about to write near-identical hedged language at all four locations with no other distinguishing detail, look again before finalizing: real whitening or fraying, even when faint, usually has SOME describable specific — a patch, a line tracking the border, concentration near one point rather than another. If a second look still shows that same real, describable mark at all four locations, report it and let the all-4 ceiling apply — genuine cards do sometimes show uniform light wear on every corner or edge from consistent handling (always picked up the same way, long-term sleeve wear), and that real pattern is exactly what the ceiling exists to catch. But if what's actually driving the finding is uncertainty rather than something you can point to and describe, the honest findings are "clean" ×4, not a hedge repeated four times.

- surface (per face): Examine for scratches, creases, indentations, stains, print defects, and gloss loss on THIS face.
  CREASES ARE SEVERE AND STRUCTURAL, NOT COSMETIC. A crease is a physical bend in the card stock, not a surface mark — treat it accordingly. If you see ANY crease, even a faint or short one, this face is not gem-mint or near-mint: score surface 40 or below, scaled by severity (a faint, short crease scores near the top of that range; a deep, long, or multiple creases score much lower, down to 1–15). Do not let good centering or sharp corners pull this score up when a crease is present. Heavy staining gets the same severity treatment as a crease.

Use the FULL range honestly on each face — do not compress toward the middle. A genuinely flawless face belongs at 96-100. A face with only light, minor wear belongs at 84-89. Judge only what you actually see — do not default toward either extreme.

DAMAGE BREAKDOWN — this is what the report is for. In "issues", list every distinct defect you actually see across both faces, and for each one, name (a) exactly which face it's on and where, and (b) which sub-dimension it drags down and roughly how much. Be specific about location every time — "whitening along ~70% of the left edge, back, edges capped at 25" is useful; "edge damage" is not. An empty issues list should be rare, reserved for cards that are genuinely flawless under close inspection on both faces. In "strengths", note anything genuinely strong (e.g. "all 4 corners sharp on the front, no whitening on any front edge") — this is what lets a real 96+ face actually read as one.

confidence reflects how certain you are given IMAGE QUALITY, not how certain you are about the score itself. A clear, well-lit photo of a card with an obvious crease should get HIGH confidence in a LOW score — do not hedge confidence just because the score itself is low. Only lower confidence when the images are blurry, poorly lit, low-resolution, or fail to show an angle you'd need.

Return ONLY valid JSON — no markdown, no code blocks. Fill each "_findings" array before its matching number, in the order shown:
{
  "front": {
    "centering_ratio": "<e.g. '55/45'>",
    "centering": <0-100>,
    "corners_findings": ["top-left: ...", "top-right: ...", "bottom-left: ...", "bottom-right: ..."],
    "corners": <0-100>,
    "edges_findings": ["top: ...", "bottom: ...", "left: ...", "right: ..."],
    "edges": <0-100>,
    "surface_findings": ["<specific defects with location, or 'clean'>"],
    "surface": <0-100>
  },
  "back": {
    "centering_ratio": "<e.g. '60/40'>",
    "centering": <0-100>,
    "corners_findings": ["top-left: ...", "top-right: ...", "bottom-left: ...", "bottom-right: ..."],
    "corners": <0-100>,
    "edges_findings": ["top: ...", "bottom: ...", "left: ...", "right: ..."],
    "edges": <0-100>,
    "surface_findings": ["<specific defects with location, or 'clean'>"],
    "surface": <0-100>
  },
  "issues": ["<specific defect, exact face + location, which sub-dimension it caps>"],
  "strengths": ["<what genuinely looks great, and on which face>"],
  "confidence": <0-100>,
  "notes": "<2-3 sentence overall assessment, naming the single most grade-limiting defect and which face it's on, if any>"
}`;

export const analyzeCardForGrading = async (
  frontBase64: string,
  frontMime: "image/jpeg" | "image/png" | "image/webp",
  backBase64: string,
  backMime: "image/jpeg" | "image/png" | "image/webp",
  cardName?: string,
  setName?: string,
): Promise<GradingAnalysis> => {
  if (!process.env.GEMINI_API_KEY) {
    throw { status: 503, message: "Gemini Vision API not configured" };
  }

  const cardContext = cardName
    ? `The card is: ${cardName}${setName ? ` from ${setName}` : ""}.`
    : "";

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
  });

  const frontPart = fileToGenerativePart(frontBase64, frontMime);
  const backPart = fileToGenerativePart(backBase64, backMime);
  const result = await model.generateContent({
    contents: [
      {
        role: "user",
        parts: [
          { text: "FRONT OF CARD:" },
          frontPart,
          { text: "BACK OF CARD:" },
          backPart,
          { text: GRADING_PROMPT(cardContext) },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      // Independent front/back findings-then-number output (worst-face-cap
      // recalibration) is roughly 3x the old single-blend schema — bumped
      // from 1024 to avoid truncating the JSON mid-object on a heavily
      // damaged card with a long findings list.
      maxOutputTokens: 4096,
      responseMimeType: "application/json",
      // Recalibration (2026-08-30): thinkingBudget was 0. Golden-set testing
      // showed the model enumerating findings correctly (e.g. whitening on
      // all 4 back edges) but then not deriving the count-based ceiling
      // from its own findings — it jumped straight to a "feels about right"
      // number instead of reconciling the count against the stated rule.
      // A small thinking budget gives it room to do that reconciliation
      // before committing to the JSON. Worth the added latency/cost for a
      // grading report; revisit if COGS become a concern.
      // @ts-ignore — thinkingConfig is valid for gemini-2.5-flash
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });

  const raw = result.response.text().trim();

  let parsed: any;
  try {
    const stripped = raw.replace(/```json\n?|```\n?/g, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(
        `No JSON object found in response. Raw: ${raw.substring(0, 200)}`,
      );
    }
    parsed = JSON.parse(stripped.substring(start, end + 1));
  } catch (err: any) {
    await logError({
      source: "inventory",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    throw new Error(`Failed to parse Gemini grading response: ${err?.message}`);
  }

  // Front/back are scored independently now (worst-face-cap recalibration).
  // Fall back to the old flat fields too, in case a stray response reverts
  // to the pre-recalibration shape — this keeps a malformed/old-format
  // response from throwing outright, just under-informed like before.
  const parseFace = (obj: any): FaceScores => ({
    centering: clamp100(obj?.centering ?? parsed.centering ?? 70),
    corners: clamp100(obj?.corners ?? parsed.corners ?? 70),
    edges: clamp100(obj?.edges ?? parsed.edges ?? 70),
    surface: clamp100(obj?.surface ?? parsed.surface ?? 70),
  });
  const front: FaceScores = parseFace(parsed.front);
  const back: FaceScores = parseFace(parsed.back);

  // Blended sub-scores feed the TP display score and computeTpScore/
  // mapTpScore's condition blend. Take the WORSE of front/back per category
  // — by construction, a clean face can never dilute a damaged one, which
  // is the core mechanism fix (previously the model blended both faces into
  // one number itself, and a good front could mask a bad back).
  const sub: SubScores = {
    centering: Math.min(front.centering, back.centering),
    corners: Math.min(front.corners, back.corners),
    edges: Math.min(front.edges, back.edges),
    surface: Math.min(front.surface, back.surface),
  };

  const tpScore = computeTpScore(sub);
  const issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [];
  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.slice(0, 5)
    : [];
  const confidence = Math.max(0, Math.min(100, parsed.confidence ?? 70));
  const centeringRatio = {
    front: parsed.front?.centering_ratio ?? parsed.centering_ratio_front ?? "Unknown",
    back: parsed.back?.centering_ratio ?? parsed.centering_ratio_back ?? null,
  };

  return {
    tpScore,
    tpDisplay: Math.round((tpScore / 10) * 10) / 10,
    sub,
    report: {
      sub,
      centering: centeringRatio,
      overallConfidence: confidence,
      strengths,
      issues,
      notes: parsed.notes ?? "",
    },
    predictions: mapTpScore(tpScore, sub, centeringRatio, { front, back }),
    centeringRatio,
    issues,
    strengths,
    confidence,
    notes: parsed.notes ?? "",
  };
};

// ─── Counterfeit Screening ─────────────────────────────────────────────────────
//
// SCREENING tool, not an authentication verdict — see
// AUDITS/counterfeit-screening-plan.md for the full doctrine this
// implements. The one-sentence version: this function must never let the
// model produce a bare "looks genuine" — every property is either an
// enumerated concern, an enumerated "checked, found nothing," or an
// enumerated abstention (photo quality / no reference / legitimate-variant
// ambiguity). The top-line result the caller derives from `findings` is
// COUNTED from what's actually in the array, never asserted independently
// by the model — same discipline as GRADING_PROMPT deriving its score from
// enumerated corner/edge findings rather than a gut number.
//
// Model config mirrors the recalibrated grading prompt's own findings
// (worktree-grading-prompt-recalibration, not yet merged to main as of
// this writing, but the config choices are independently justified here,
// not borrowed on faith): temperature 0 for determinism (a counterfeit
// verdict flip-flopping run-to-run on the same photos is the same failure
// class the grading recalibration fixed at this exact setting), thinking
// budget 1024 so enumerated findings actually get used rather than
// enumerated-then-ignored.

export type CounterfeitSeverity = "none" | "minor" | "concerning" | "strong";

export const COUNTERFEIT_CHECK_PROPERTIES = [
  "font_letter_spacing",
  "color_saturation",
  "print_quality",
  "energy_symbol",
  "copyright_line",
  "holo_pattern",
  "back_side_hue",
  "border_alignment",
  "edge_core_appearance",
  "backlight_result",
] as const;

export type CounterfeitCheckProperty =
  (typeof COUNTERFEIT_CHECK_PROPERTIES)[number];

export interface CounterfeitFinding {
  property: CounterfeitCheckProperty;
  findingText: string;
  severity: CounterfeitSeverity;
  confidence: number; // 0–100, evidentiary quality for THIS property, not verdict certainty
  referenceUsed: boolean;
}

export interface CounterfeitScreeningAnalysis {
  findings: CounterfeitFinding[];
  overallConfidence: number; // 0–100, capped when backlit photo or reference is missing
  notes: string;
  rawResponse: string;
}

const COUNTERFEIT_SCREENING_PROMPT = (opts: {
  cardContext: string;
  hasReference: boolean;
  hasBacklit: boolean;
}) => `You are screening photos of a trading card for signs of counterfeiting. This is NOT an authentication — you are not a grading company, you cannot hold the physical card, and your output will never claim the card IS genuine. Your job is to enumerate what you can and cannot check from these photos, and flag anything that looks wrong. ${opts.cardContext}

HARD RULE, before anything else: you may never conclude that a card IS genuine or authentic. "Nothing concerning found" is a valid, common, and expected result for a property — it is NOT the same as "this card is real," and your output must never phrase it that way. Every property below gets one of three outcomes: (1) a specific concern, (2) "checked, nothing concerning found" — a real, specific, evidence-based finding in its own right, not silence, or (3) an explicit abstention naming exactly why you can't check it (poor image quality for that property, no catalog reference available, or the pattern is also consistent with a known legitimate variant — see below). There is no fourth outcome where you simply assert the card looks fine overall.

ANTI-ANCHOR: "checked, nothing concerning found" across every property is a specific claim — that you actually examined each one against what a genuine card of this type looks like and found no discrepancy. It is not a safe default for when you're unsure; if you're unsure, the honest finding is abstention (outcome 3 above), not a clean bill of health. Equally, do not manufacture a concern to seem thorough — a genuinely well-printed counterfeit-free-looking card should produce mostly "nothing concerning found" findings, and that is a normal, correct result, not a suspicious gap in your analysis. Accuracy in both directions matters: false concerns can wreck a legitimate seller's sale, a false clean bill of health on a real counterfeit is the worse failure mode by far — when genuinely uncertain between the two, lean toward flagging the concern with appropriately modest confidence rather than suppressing it, but do not invent detail you can't see to justify a flag.

LEGITIMATE-VARIANT CARVE-OUT: some real, authentic cards look unusual by design — official test prints, known misprints/error cards, foreign-language legitimate releases, and pre-release promos can trigger the same visual signals as counterfeits (off-register printing, unusual color, a non-standard back). If a finding pattern is also plausibly explained by a known legitimate variant, say so explicitly in that property's finding_text and use abstention or "minor" severity rather than "concerning"/"strong" — name the alternative explanation, don't just soften the language.

${opts.hasReference ? "A CATALOG REFERENCE IMAGE of this exact card is provided — use it directly for font/spacing, color saturation, and holo-pattern comparisons. Findings for those properties should cite specific differences from the reference, not general impressions." : "NO catalog reference image is available for this card (identification failed or wasn't confident enough to trust). For font_letter_spacing, color_saturation, and holo_pattern, you MUST abstain — set severity to \"none\", set referenceUsed to false, and say plainly in finding_text that this property needs a confirmed reference to check. Do not compare against your general knowledge of what this card 'should' look like as a substitute for a real reference — that is exactly the kind of unfounded claim this tool must not make."}

${opts.hasBacklit ? "A BACKLIT photo is provided — the card was photographed against a light source. Genuine trading cards have an opaque core layer and block most light; a counterfeit printed on thinner or different stock often glows through visibly. Assess this directly and specifically: does light pass through, and how much?" : "NO backlit photo was provided (the user skipped this step). Set the backlight_result finding's severity to \"none\" and confidence to 0, and say explicitly in finding_text that this check was skipped, not that it passed. This is one of the strongest available checks — its absence should be treated as a real gap in the screen, not a neutral non-issue."}

Check each of these 10 properties independently. For EACH, write finding_text FIRST — the specific thing you observed or the specific reason you can't check it — before deciding severity. Never assign a severity you can't point to a specific observation for.

1. font_letter_spacing — font weight, letter spacing, and kerning on the card name/attack text vs. what's expected for this card
2. color_saturation — color accuracy and saturation vs. reference or general print-quality expectations
3. print_quality — halftone dot pattern, blurriness, or softness inconsistent with authentic offset/lithographic printing (genuine Pokémon cards do not show visible halftone dots at normal viewing distance; visible dot patterns are a strong counterfeit indicator)
4. energy_symbol — energy symbol shape, color, and placement correctness
5. copyright_line — presence and exact format of the copyright line (year, ©, the Nintendo/Creatures/GAME FREAK stack appropriate to this card's era)
6. holo_pattern — holo foil pattern type match vs. reference, where the card has holo treatment (severity "none" with finding_text "not a holo card" if it doesn't)
7. back_side_hue — back-of-card color plausibility (Pokémon-card-blue, or reference-backed exact match when a reference is available)
8. border_alignment — print registration/alignment relative to the card's cut edge — this is about the PRINT position, distinct from physical centering
9. edge_core_appearance — visible card-stock edge color and texture in the front/back photos
10. backlight_result — see instructions above

Return ONLY valid JSON, no markdown, no code blocks:
{
  "findings": [
    {
      "property": "<one of the 10 property names above, exactly as written>",
      "finding_text": "<specific observation, or specific reason for abstention>",
      "severity": "none" | "minor" | "concerning" | "strong",
      "confidence": <0-100, how much you trust the EVIDENCE for this specific property — image quality, reference availability — not how sure you feel about the overall card>,
      "reference_used": <true if this finding directly compared against the provided catalog reference image, false otherwise>
    }
    // exactly 10 objects, one per property, in the order listed above
  ],
  "overall_confidence": <0-100, factoring in image quality across all photos, whether a reference was available, and whether the backlit photo was included — cap this well below 70 whenever the backlit photo was skipped>,
  "notes": "<2-3 sentences: what you'd tell the person who submitted these photos, naming the single most significant concern if any, and reiterating this is a screen, not authentication>"
}`;

export const analyzeCardForCounterfeits = async (
  images: {
    frontBase64: string;
    frontMime: "image/jpeg" | "image/png" | "image/webp";
    backBase64: string;
    backMime: "image/jpeg" | "image/png" | "image/webp";
    backlitBase64?: string;
    backlitMime?: "image/jpeg" | "image/png" | "image/webp";
  },
  reference: { base64: string; mime: "image/jpeg" | "image/png" | "image/webp" } | null,
  cardName?: string,
  setName?: string,
): Promise<CounterfeitScreeningAnalysis> => {
  if (!process.env.GEMINI_API_KEY) {
    throw { status: 503, message: "Gemini Vision API not configured" };
  }

  const cardContext = cardName
    ? `The submitter identifies this as: ${cardName}${setName ? `, from ${setName}` : ""}. Treat this as a hint, not a confirmed fact — your own visual checks are what matter.`
    : "The card could not be confidently identified from the photos — treat every reference-dependent check as unavailable regardless of what you might guess this card to be.";

  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
    safetySettings: [
      {
        category: HarmCategory.HARM_CATEGORY_HARASSMENT,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
      {
        category: HarmCategory.HARM_CATEGORY_HATE_SPEECH,
        threshold: HarmBlockThreshold.BLOCK_NONE,
      },
    ],
  });

  const parts: Part[] = [
    { text: "FRONT OF CARD:" },
    fileToGenerativePart(images.frontBase64, images.frontMime),
    { text: "BACK OF CARD:" },
    fileToGenerativePart(images.backBase64, images.backMime),
  ];
  if (images.backlitBase64 && images.backlitMime) {
    parts.push(
      { text: "BACKLIT PHOTO (card held against a light source):" },
      fileToGenerativePart(images.backlitBase64, images.backlitMime),
    );
  }
  if (reference) {
    parts.push(
      { text: "CATALOG REFERENCE IMAGE (known-genuine printing of this exact card, for comparison):" },
      fileToGenerativePart(reference.base64, reference.mime),
    );
  }
  parts.push({
    text: COUNTERFEIT_SCREENING_PROMPT({
      cardContext,
      hasReference: !!reference,
      hasBacklit: !!images.backlitBase64,
    }),
  });

  const result = await model.generateContent({
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 2048,
      responseMimeType: "application/json",
      // @ts-ignore — thinkingConfig is valid for gemini-2.5-flash
      thinkingConfig: { thinkingBudget: 1024 },
    },
  });

  const raw = result.response.text().trim();

  let parsed: any;
  try {
    const stripped = raw.replace(/```json\n?|```\n?/g, "").trim();
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start === -1 || end === -1) {
      throw new Error(
        `No JSON object found in response. Raw: ${raw.substring(0, 200)}`,
      );
    }
    parsed = JSON.parse(stripped.substring(start, end + 1));
  } catch (err: any) {
    await logError({
      source: "counterfeit-screening",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    throw new Error(
      `Failed to parse Gemini counterfeit-screening response: ${err?.message}`,
    );
  }

  const validProperties = new Set(COUNTERFEIT_CHECK_PROPERTIES);
  const validSeverities = new Set<CounterfeitSeverity>([
    "none",
    "minor",
    "concerning",
    "strong",
  ]);

  const findings: CounterfeitFinding[] = (
    Array.isArray(parsed.findings) ? parsed.findings : []
  )
    .filter((f: any) => validProperties.has(f?.property))
    .map((f: any) => ({
      property: f.property as CounterfeitCheckProperty,
      findingText: typeof f.finding_text === "string" ? f.finding_text : "",
      severity: validSeverities.has(f?.severity) ? f.severity : "none",
      confidence: Math.max(0, Math.min(100, Number(f?.confidence) || 0)),
      referenceUsed: f?.reference_used === true,
    }));

  return {
    findings,
    overallConfidence: Math.max(
      0,
      Math.min(100, Number(parsed.overall_confidence) || 0),
    ),
    notes: typeof parsed.notes === "string" ? parsed.notes : "",
    rawResponse: raw,
  };
};

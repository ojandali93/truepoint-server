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

export function mapTpScore(
  _tpScore: number,
  sub: SubScores,
  centering?: { front?: string | null; back?: string | null },
) {
  // Condition score EXCLUDING centering. Centering is applied separately as a
  // per-company ceiling (below) rather than averaged in — otherwise a card that
  // PSA would still gem (e.g. 60/40 front) gets silently dragged below a 10 by
  // the blend, which is exactly why good cards were under-predicting.
  const condWeighted =
    (sub.surface * 0.4 + sub.corners * 0.32 + sub.edges * 0.28) / 1;
  const condMin = Math.min(sub.corners, sub.edges, sub.surface);
  const condition = clamp100(condWeighted * 0.75 + condMin * 0.25);
  const g = condition / 10; // grade-equivalent from condition alone

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
    ? 990 + Math.round((Math.min(condition, 100) - 99) * 10) // 990–1000
    : tagGrade >= 10
      ? 950 + Math.round(Math.min(39, Math.max(0, condition - 96) * 13)) // 950–989
      : tagGrade >= 9
        ? 900 + Math.round(Math.min(49, Math.max(0, condition - 90) * 8)) // 900–949
        : tagGrade >= 8.5
          ? 850 + Math.round(Math.min(49, Math.max(0, condition - 85) * 9)) // 850–899
          : tagGrade >= 8
            ? 800 + Math.round(Math.min(49, Math.max(0, condition - 80) * 9)) // 800–849
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
) => `You are a trading-card condition analyst. You are given the FRONT image and the BACK image of a single Pokémon TCG card.${cardContext ? " " + cardContext : ""}

Score the card's intrinsic physical quality on a 0–100 scale. This is NOT a PSA/BGS/CGC/TAG grade — DO NOT output any company grade. Score raw quality so it can be mapped to grades afterward.

Evaluate FOUR sub-dimensions, each 0–100, looking at BOTH front and back:
- centering: MEASURE IT, don't guess. For each axis, compare the two opposite borders: ratio = (wider border ÷ (both borders combined)) × 100. Do this LEFT-TO-RIGHT and TOP-TO-BOTTOM, on the front AND the back, and report the ratios in centering_ratio_front / centering_ratio_back using the WORST axis (e.g. left border 3mm, right 2mm → 3/(3+2) = 60 → "60/40"). Report 50/50 only if it truly is. These ratios drive the grade directly, so accuracy here matters more than anything else. For the 0-100 centering score, use: 50/50 ≈ 100; 55/45 ≈ 92; 60/40 ≈ 84; 65/35 ≈ 74; 70/30 ≈ 64; worse is poor.
- corners: sharpness/wear of all four corners on both sides.
- edges: cleanliness/whitening/nicks along all edges, both sides.
- surface: scratches, print lines, dimples, scuffs, holo scratches, gloss, both sides.

Use the FULL range honestly — do NOT compress toward the middle. Anchor each score to the grade a clean example of that condition would earn, so a genuinely gem-mint card reaches the top band:
- 96–100: gem-mint — sharp corners, clean surface, tight centering. This is what a PSA 10 / BGS 9.5–10 card looks like. If it looks flawless to the naked eye, score here. Do NOT hold back or treat this band as "rare."
- 90–95: mint — one or two trivial flaws (PSA 9).
- 84–89: near-mint-mint — minor but visible wear: slight edge whitening, light surface, centering ~60/40 (PSA 8).
- 75–83: near-mint — light wear clearly visible.
- 60–74: moderate handling wear.
- 40–59: heavy wear.
- 1–39: poor/damaged.

Judge only what you actually see in the images. A clean, sharp, well-centered card genuinely earns 96–99 — score it there rather than defaulting low. A perfect-looking card SHOULD score in the 96–100 band. Use precise values (e.g. 87, 93, 97), never round-number defaults. If the image is poor quality, keep the score honest and instead LOWER your confidence (do not just lower the score).

Return ONLY valid JSON — no markdown, no code blocks:
{
  "centering": <0-100>,
  "corners": <0-100>,
  "edges": <0-100>,
  "surface": <0-100>,
  "centering_ratio_front": "<e.g. '55/45'>",
  "centering_ratio_back": "<e.g. '60/40' or null>",
  "issues": ["<specific defect>"],
  "strengths": ["<what looks great>"],
  "confidence": <0-100>,
  "notes": "<2-3 sentence overall assessment>"
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
      temperature: 0.1,
      maxOutputTokens: 1024,
      responseMimeType: "application/json",
      // @ts-ignore — thinkingConfig is valid for gemini-2.5-flash
      thinkingConfig: { thinkingBudget: 0 },
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

  const sub: SubScores = {
    centering: clamp100(parsed.centering ?? 70),
    corners: clamp100(parsed.corners ?? 70),
    edges: clamp100(parsed.edges ?? 70),
    surface: clamp100(parsed.surface ?? 70),
  };

  const tpScore = computeTpScore(sub);
  const issues = Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [];
  const strengths = Array.isArray(parsed.strengths)
    ? parsed.strengths.slice(0, 5)
    : [];
  const confidence = Math.max(0, Math.min(100, parsed.confidence ?? 70));
  const centeringRatio = {
    front: parsed.centering_ratio_front ?? "Unknown",
    back: parsed.centering_ratio_back ?? null,
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
    predictions: mapTpScore(tpScore, sub, centeringRatio),
    centeringRatio,
    issues,
    strengths,
    confidence,
    notes: parsed.notes ?? "",
  };
};

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
    tag: { grade: number; label: string; isPristine: boolean; score1000: number };
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

export function mapTpScore(tpScore: number, sub: SubScores) {
  const g = tpScore / 10; // grade-equivalent, e.g. 93 -> 9.3
  const allGem =
    Math.min(sub.centering, sub.corners, sub.edges, sub.surface) >= 99;
  const nearPerfect = tpScore >= 99;

  // PSA — nearest whole number.
  const psaGrade = toWhole(g);
  const psa = {
    grade: psaGrade,
    label: `PSA ${psaGrade} ${PSA_NAMES[psaGrade] ?? ""}`.trim(),
  };

  // BGS — nearest half.
  const bgsGrade = toHalf(g);
  const bgsBlack = allGem && bgsGrade >= 10;
  const bgs = {
    grade: bgsGrade,
    label: bgsBlack
      ? "BGS 10 Black Label"
      : `BGS ${fmtGrade(bgsGrade)} ${tierName(bgsGrade)}`.trim(),
    isBlackLabel: bgsBlack,
  };

  // CGC — nearest half.
  const cgcGrade = toHalf(g);
  const cgcPristine = nearPerfect && cgcGrade >= 10;
  const cgc = {
    grade: cgcGrade,
    label: cgcPristine
      ? "CGC Pristine 10"
      : `CGC ${fmtGrade(cgcGrade)} ${tierName(cgcGrade)}`.trim(),
    isPristine: cgcPristine,
  };

  // TAG — nearest half.
  const tagGrade = toHalf(g);
  const tagPristine = nearPerfect && tagGrade >= 10;
  const tag = {
    grade: tagGrade,
    label: tagPristine
      ? "TAG Pristine 10"
      : `TAG ${fmtGrade(tagGrade)} ${tierName(tagGrade)}`.trim(),
    isPristine: tagPristine,
    score1000: Math.max(100, Math.min(1000, Math.round(tpScore * 10))),
  };

  return { psa, bgs, cgc, tag };
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

const GRADING_PROMPT = (
  cardContext: string,
) => `You are a trading-card condition analyst. You are given the FRONT image and the BACK image of a single Pokémon TCG card.${cardContext ? " " + cardContext : ""}

Score the card's intrinsic physical quality on a 0–100 scale. This is NOT a PSA/BGS/CGC/TAG grade — DO NOT output any company grade. Score raw quality so it can be mapped to grades afterward.

Evaluate FOUR sub-dimensions, each 0–100, looking at BOTH front and back:
- centering: how centered the artwork is within the borders (front weighted most). PSA/BGS allow some offset even at the top grades, so don't over-penalize: 50/50–55/45 ≈ 95–100 (both are 10-worthy); 60/40 ≈ 86; 65/35 ≈ 76; 70/30 ≈ 66; worse is poor.
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
    predictions: mapTpScore(tpScore, sub),
    centeringRatio,
    issues,
    strengths,
    confidence,
    notes: parsed.notes ?? "",
  };
};

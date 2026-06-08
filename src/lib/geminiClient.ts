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
// Two-stage design to fix grade clustering at 9:
//   1. Gemini scores intrinsic quality 0–100 across four sub-dimensions (front
//      + back). It is explicitly told NOT to output a company grade, and the
//      0–100 scale (not 1–10) stops it anchoring to the modal real grade.
//   2. We compute a single TP Score in code (weighted, dragged toward the
//      weakest sub-dimension the way real grading is gated by the worst
//      attribute), then map it to where each company would most likely land.
// The mapping is deterministic and tunable in this file.

export interface SubScores {
  centering: number; // 0–100
  corners: number; // 0–100
  edges: number; // 0–100
  surface: number; // 0–100
}

export interface CompanyPrediction {
  company: "PSA" | "BGS" | "CGC" | "SGC" | "TAG";
  likely: string; // e.g. "9.5" or "10"
  range: string; // e.g. "9 – 9.5"
  note?: string; // e.g. "Black Label 10 possible"
}

export interface GradingAnalysis {
  tpScore: number; // 0–100 (store as int)
  tpDisplay: number; // tpScore / 10, one decimal (e.g. 9.6) — convenience for UI
  sub: SubScores; // 0–100 each
  predictions: CompanyPrediction[];
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

const fmtGrade = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);
const toHalf = (x: number) => Math.round(x * 2) / 2;
const floorHalf = (x: number) => Math.floor(x * 2) / 2;
const ceilHalf = (x: number) => Math.ceil(x * 2) / 2;
const clamp10 = (x: number) => Math.max(1, Math.min(10, x));

export function mapTpScore(
  tpScore: number,
  sub: SubScores,
): CompanyPrediction[] {
  const g = tpScore / 10; // decimal grade-equivalent, e.g. 93 -> 9.3
  const allGem =
    Math.min(sub.centering, sub.corners, sub.edges, sub.surface) >= 99;
  const nearPerfect = tpScore >= 99;

  // PSA — whole grades only, grades conservatively (rounds down).
  const psaBase = clamp10(Math.floor(g));
  const psaLikely = g >= 9.8 ? 10 : psaBase;
  const psaRange =
    g >= 9.8
      ? "9 – 10"
      : g - psaBase >= 0.5
        ? `${psaBase} – ${clamp10(psaBase + 1)}`
        : `${psaBase}`;

  // Half-grade companies (BGS, CGC, SGC): round to nearest 0.5, show bracket.
  const half = (
    company: CompanyPrediction["company"],
    note?: string,
  ): CompanyPrediction => {
    const lo = clamp10(floorHalf(g));
    const hi = clamp10(ceilHalf(g));
    return {
      company,
      likely: fmtGrade(clamp10(toHalf(g))),
      range: lo === hi ? fmtGrade(lo) : `${fmtGrade(lo)} – ${fmtGrade(hi)}`,
      note,
    };
  };

  // TAG — reports to the tenth, so map almost directly.
  const tagLikely = clamp10(Number(g.toFixed(1)));
  const tagLo = clamp10(Number((g - 0.2).toFixed(1)));
  const tagHi = clamp10(Number((g + 0.2).toFixed(1)));

  return [
    {
      company: "PSA",
      likely: fmtGrade(psaLikely),
      range: psaRange,
      note: g >= 9.8 ? "Gem Mint 10 in play" : undefined,
    },
    half("BGS", allGem ? "Black Label 10 possible (all subs gem)" : undefined),
    half("CGC", nearPerfect ? "Pristine 10 possible" : undefined),
    half("SGC", nearPerfect ? "Gold Label 10 possible" : undefined),
    {
      company: "TAG",
      likely: fmtGrade(tagLikely),
      range:
        tagLo === tagHi
          ? fmtGrade(tagLo)
          : `${fmtGrade(tagLo)} – ${fmtGrade(tagHi)}`,
    },
  ];
}

// ─── Prompt ────────────────────────────────────────────────────────────────────

const GRADING_PROMPT = (
  cardContext: string,
) => `You are a trading-card condition analyst. You are given the FRONT image and the BACK image of a single Pokémon TCG card.${cardContext ? " " + cardContext : ""}

Score the card's intrinsic physical quality on a 0–100 scale. This is NOT a PSA/BGS/CGC/TAG grade — DO NOT output any company grade. Score raw quality so it can be mapped to grades afterward.

Evaluate FOUR sub-dimensions, each 0–100, looking at BOTH front and back:
- centering: how centered the artwork is within the borders (front weighted most). 50/50 ≈ 100; 55/45 ≈ 90; 60/40 ≈ 80; 65/35 ≈ 70; 70/30+ is poor.
- corners: sharpness/wear of all four corners on both sides.
- edges: cleanliness/whitening/nicks along all edges, both sides.
- surface: scratches, print lines, dimples, scuffs, holo scratches, gloss, both sides.

Use the FULL range. Anchor to this rubric:
- 97–100: flawless under magnification; gem-mint candidate. Rare.
- 90–96: excellent; only trivial flaws, sharp to the naked eye.
- 80–89: strong but visible minor wear (slight edge whitening, light surface, centering ~60/40).
- 70–79: light-to-moderate wear clearly visible.
- 55–69: moderate handling wear.
- 30–54: heavy wear.
- 1–29: poor/damaged.

Most pack-pulled raw cards land 80–95. Reserve 96+ for genuinely flawless. DO NOT default to round numbers like 90 or 95 — use precise values (e.g. 87, 93, 96). Examine each sub-dimension before settling on a number, and be conservative if image quality is poor (lower your confidence).

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
      // Force clean JSON so we don't fight markdown fences.
      responseMimeType: "application/json",
      // Disable thinking — not needed for grading, just adds latency/noise.
      // @ts-ignore — thinkingConfig is valid for gemini-2.5-flash
      thinkingConfig: { thinkingBudget: 0 },
    },
  });

  const raw = result.response.text().trim();

  let parsed: any;
  try {
    // responseMimeType should give clean JSON; this strip is a defensive net.
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
      source: "inventory", // ← change per controller
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

  return {
    tpScore,
    tpDisplay: Math.round((tpScore / 10) * 10) / 10,
    sub,
    predictions: mapTpScore(tpScore, sub),
    centeringRatio: {
      front: parsed.centering_ratio_front ?? "Unknown",
      back: parsed.centering_ratio_back ?? null,
    },
    issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 8) : [],
    strengths: Array.isArray(parsed.strengths)
      ? parsed.strengths.slice(0, 5)
      : [],
    confidence: Math.max(0, Math.min(100, parsed.confidence ?? 70)),
    notes: parsed.notes ?? "",
  };
};

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

// ─── AI Grading (v2: deep objective report + per-company grader) ──────────────
//
// TWO-STAGE, BIAS-RESISTANT DESIGN
//   Stage 1 — the ANALYST (Gemini vision): produces an OBJECTIVE report only —
//     per-corner / per-edge / surface findings, centering ratios on both axes,
//     dimensions, and DINGS (Defects of notable Grade significance). It is told
//     NOT to output any company grade, so it can't anchor to a market-expected
//     number. Every category carries a confidence.
//   Stage 2 — the GRADER (this file, deterministic code): never sees the image.
//     It maps the objective numbers to PSA / BGS / CGC / TAG using each
//     company's real rules, applies weakest-link + centering ceilings + DING
//     capping, and returns a grade RANGE + the limiting factor + a confidence.
//
// Company thresholds encoded below reflect published 2026 standards (PSA
// centering bands & whole grades; BGS 0.5 subgrades with lowest-subgrade floor
// and 50/50 Black-Label centering; CGC PSA-scale + strict top-end; TAG
// 1000-pt with 950+ = 10, 990+ = Pristine and TCG centering tolerances).

export interface SubScores {
  centering: number; // 0–100
  corners: number; // 0–100
  edges: number; // 0–100
  surface: number; // 0–100
}

export type Side = "front" | "back";

export interface CornerFinding {
  side: Side;
  position: "TL" | "TR" | "BL" | "BR";
  score: number; // 0–100 sharpness (100 = razor sharp)
  whitening: number; // 0–100 (0 = none)
  notes?: string;
}

export interface EdgeFinding {
  side: Side;
  position: "top" | "bottom" | "left" | "right";
  score: number; // 0–100
  whitening: number; // 0–100
  chipping: number; // 0–100
  notes?: string;
}

export interface SurfaceFinding {
  side: Side;
  type:
    | "scratch"
    | "print_line"
    | "dent"
    | "scuff"
    | "holo_scratch"
    | "stain"
    | "gloss_loss"
    | "print_defect"
    | "other";
  severity: number; // 0–100
  location: string;
  notes?: string;
}

export interface CenteringMeasure {
  side: Side;
  leftRight: string; // e.g. "52/48"
  topBottom: string; // e.g. "48/52"
  worstAxisPct: number; // larger side of the worst axis, e.g. 52
}

/** A Defect of notable Grade significance — the thing that CAPS the grade. */
export interface Ding {
  side: Side;
  category: "corner" | "edge" | "surface" | "centering";
  location: string;
  type: string;
  severity: number; // 0–100 (grade impact)
  confidence: number; // 0–100
}

export interface CategoryConfidence {
  centering: number; // high — geometric, reliable from a photo
  corners: number; // medium
  edges: number; // medium
  surface: number; // lower — micro-scratches need multi-angle light
}

export interface ObjectiveReport {
  centering: CenteringMeasure[]; // front + back
  corners: CornerFinding[]; // up to 8
  edges: EdgeFinding[]; // up to 8
  surface: SurfaceFinding[];
  dimensions: { heightIn: number | null; widthIn: number | null };
  dings: Ding[];
  sub: SubScores; // 0–100 category rollups
  categoryConfidence: CategoryConfidence;
  overallConfidence: number; // 0–100
  strengths: string[];
  issues: string[];
  notes: string;
}

export interface GradePrediction {
  grade: number; // point estimate
  gradeRange: [number, number];
  label: string;
  limitingFactor: string;
  confidence: number; // 0–100
  isBlackLabel?: boolean;
  isPristine?: boolean;
  subgrades?: {
    centering: number;
    corners: number;
    edges: number;
    surface: number;
  }; // BGS (1–10)
  qualifiers?: string[]; // PSA OC/ST/PD/MK/MC
}

export interface GradingAnalysis {
  tpScore: number; // 0–100 canonical objective score
  tpDisplay: number; // tpScore/10
  sub: SubScores;
  report: ObjectiveReport; // Phase-1 depth
  predictions: {
    psa: GradePrediction;
    bgs: GradePrediction;
    cgc: GradePrediction;
    tag: GradePrediction & { score1000: number };
  };
  // Back-compat fields the current UI reads (kept until Phase-3 UI ships):
  centeringRatio: { front: string; back: string | null };
  issues: string[];
  strengths: string[];
  confidence: number;
  notes: string;
}

// ─── small helpers ────────────────────────────────────────────────────────────

const clamp100 = (v: number) => Math.max(1, Math.min(100, Math.round(v)));
const clamp10 = (x: number) => Math.max(1, Math.min(10, x));
const toHalf = (x: number) => clamp10(Math.round(x * 2) / 2);
const toWhole = (x: number) => clamp10(Math.round(x));
const fmtGrade = (n: number) =>
  Number.isInteger(n) ? String(n) : n.toFixed(1);

/** Larger side of the worst axis from two "a/b" ratio strings. */
function worstAxisFromRatios(lr: string, tb: string): number {
  const larger = (s: string): number => {
    const parts = String(s ?? "")
      .split("/")
      .map((n) => parseFloat(n));
    if (parts.length !== 2 || !parts[0] || !parts[1]) return 50;
    return Math.max(parts[0], parts[1]);
  };
  return Math.max(larger(lr), larger(tb));
}

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
  if (grade >= 6) return "Excellent-Mint";
  if (grade >= 5) return "Excellent";
  return "";
};

// ─── TP Score (objective 0–100) ───────────────────────────────────────────────

const WEIGHTS = { centering: 0.3, surface: 0.28, corners: 0.22, edges: 0.2 };
const MIN_WEIGHT = 0.25;

export function computeTpScore(s: SubScores): number {
  const weighted =
    s.centering * WEIGHTS.centering +
    s.surface * WEIGHTS.surface +
    s.corners * WEIGHTS.corners +
    s.edges * WEIGHTS.edges;
  const min = Math.min(s.centering, s.corners, s.edges, s.surface);
  return clamp100(weighted * (1 - MIN_WEIGHT) + min * MIN_WEIGHT);
}

// ─── centering ceilings (per company) ─────────────────────────────────────────

/** PSA front/back centering → max whole grade the centering allows. */
function psaCenteringCeiling(front: number, back: number): number {
  const f =
    front <= 55
      ? 10
      : front <= 60
        ? 9
        : front <= 65
          ? 8
          : front <= 70
            ? 7
            : front <= 80
              ? 6
              : front <= 85
                ? 5
                : 4;
  const b = back <= 75 ? 10 : back <= 90 ? 9 : 7; // back looser; 90/10 holds 7–9
  return Math.min(f, b);
}

/** BGS centering SUBGRADE (0.5 scale). Front weighted; Black Label needs ~50/50. */
function bgsCenteringSub(front: number, back: number): number {
  const f =
    front <= 50.5
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
    back <= 55 ? 10 : back <= 60 ? 9.5 : back <= 70 ? 9 : back <= 75 ? 8.5 : 8;
  // Front dominates; back can only pull down, and one band more forgiving.
  return clamp10(Math.min(f, Math.min(10, b + 0.5)));
}

/** TAG centering → 1000-scale ceiling (TCG tolerances). */
function tagCenteringCeiling1000(front: number, back: number): number {
  if (front <= 52 && back <= 55) return 1000; // Pristine-eligible
  if (front <= 55 && back <= 65) return 949; // strong 10, just under Pristine
  if (front <= 60) return 899;
  if (front <= 65) return 849;
  if (front <= 70) return 799;
  return 699;
}

// ─── DING capping ─────────────────────────────────────────────────────────────

/** Most-severe confident ding → grade ceiling (1–10) + human label. */
function dingCap(dings: Ding[]): { cap10: number; factor: string | null } {
  if (!dings || dings.length === 0) return { cap10: 10, factor: null };
  const eff = (d: Ding) => d.severity * (d.confidence / 100);
  const worst = dings.reduce((a, d) => (eff(d) > eff(a) ? d : a));
  const e = eff(worst);
  const cap10 =
    e >= 70 ? 6 : e >= 55 ? 7 : e >= 45 ? 8 : e >= 30 ? 9 : e >= 15 ? 9.5 : 10;
  return {
    cap10,
    factor: `${worst.side} ${worst.category} — ${worst.type} (${worst.location})`,
  };
}

/** Grade range from a point estimate + overall confidence. */
function rangeFor(
  point: number,
  confidence: number,
  step: 0.5 | 1,
): [number, number] {
  const width = confidence >= 85 ? 0 : confidence >= 70 ? step : step * 2;
  const lo = clamp10(point - width);
  const hi = clamp10(point);
  return [
    step === 1 ? toWhole(lo) : toHalf(lo),
    step === 1 ? toWhole(hi) : toHalf(hi),
  ];
}

// ─── qualifiers (PSA) ─────────────────────────────────────────────────────────

function psaQualifiers(
  r: ObjectiveReport,
  frontPct: number,
  backPct: number,
): string[] {
  const q: string[] = [];
  if (frontPct > 60 || backPct > 90) q.push("OC"); // off-centre for the grade band
  if (r.surface.some((s) => s.type === "stain")) q.push("ST");
  if (
    r.surface.some((s) => s.type === "print_line" || s.type === "print_defect")
  )
    q.push("PD");
  return q;
}

// ─── Stage 2: the grader ──────────────────────────────────────────────────────

export function predictGrades(
  report: ObjectiveReport,
): GradingAnalysis["predictions"] {
  const sub = report.sub;
  const conf = report.overallConfidence;

  const front = report.centering.find((c) => c.side === "front");
  const back = report.centering.find((c) => c.side === "back");
  const frontPct = front
    ? front.worstAxisPct ||
      worstAxisFromRatios(front.leftRight, front.topBottom)
    : 50;
  const backPct = back
    ? back.worstAxisPct || worstAxisFromRatios(back.leftRight, back.topBottom)
    : 50;

  // Category grade-equivalents (0–100 → 1–10) and the weakest link.
  const cat = {
    centering: sub.centering / 10,
    corners: sub.corners / 10,
    edges: sub.edges / 10,
    surface: sub.surface / 10,
  };
  const weakest = Math.min(cat.centering, cat.corners, cat.edges, cat.surface);
  const weakestName = (Object.keys(cat) as (keyof typeof cat)[]).reduce(
    (a, k) => (cat[k] < cat[a] ? k : a),
  );

  const ding = dingCap(report.dings);
  const base = computeTpScore(sub) / 10;

  // Which cap is binding (for the limiting-factor string).
  const bindingFactor = (ceiling: number): string => {
    if (ding.factor && Math.abs(ding.cap10 - ceiling) < 1e-6)
      return ding.factor;
    if (Math.abs(weakest - ceiling) < 1e-6)
      return `${weakestName} (weakest sub-grade)`;
    return "centering";
  };

  // ── PSA — whole grades, weakest-link, zero-tolerance 10 ──
  const psaCeil = Math.min(
    weakest,
    psaCenteringCeiling(frontPct, backPct),
    ding.cap10,
  );
  let psaPoint = Math.min(base, psaCeil);
  // PSA 10 requires everything essentially perfect.
  if (psaPoint >= 9.5 && (weakest < 9.7 || ding.cap10 < 10 || frontPct > 55)) {
    psaPoint = Math.min(psaPoint, 9);
  }
  const psaGrade = toWhole(psaPoint);
  const psaQ = psaQualifiers(report, frontPct, backPct);
  const psa: GradePrediction = {
    grade: psaGrade,
    gradeRange: rangeFor(psaPoint, conf, 1),
    label: `PSA ${psaGrade} ${PSA_NAMES[psaGrade] ?? ""}`.trim(),
    limitingFactor: bindingFactor(psaCeil),
    confidence: conf,
    qualifiers: psaQ,
  };

  // ── BGS — 0.5 subgrades, lowest floors, second-lowest caps, Black Label = 4×10 ──
  const bgsSub = {
    centering: bgsCenteringSub(frontPct, backPct),
    corners: toHalf(cat.corners),
    edges: toHalf(cat.edges),
    surface: toHalf(cat.surface),
  };
  const bgsVals = [
    bgsSub.centering,
    bgsSub.corners,
    bgsSub.edges,
    bgsSub.surface,
  ].sort((a, b) => a - b);
  const lowest = bgsVals[0];
  const secondLowest = bgsVals[1];
  // Overall: lowest sets the floor, second-lowest caps the ceiling; ding still caps.
  const bgsFromSubs = Math.min(secondLowest, Math.max(lowest, base));
  const bgsPoint = Math.min(bgsFromSubs, ding.cap10);
  const bgsGrade = toHalf(bgsPoint);
  const bgsBlack =
    bgsSub.centering >= 10 &&
    bgsSub.corners >= 10 &&
    bgsSub.edges >= 10 &&
    bgsSub.surface >= 10 &&
    !ding.factor;
  const bgs: GradePrediction = {
    grade: bgsGrade,
    gradeRange: rangeFor(bgsPoint, conf, 0.5),
    label: bgsBlack
      ? "BGS 10 Black Label"
      : `BGS ${fmtGrade(bgsGrade)} ${tierName(bgsGrade)}`.trim(),
    limitingFactor: ding.factor ?? `${weakestName} sub-grade`,
    confidence: conf,
    isBlackLabel: bgsBlack,
    subgrades: bgsSub,
  };

  // ── CGC — PSA-scale but half grades; Pristine 10 needs near-perfect everything ──
  const cgcCeil = Math.min(
    weakest,
    ding.cap10,
    psaCenteringCeiling(frontPct, backPct) + 0.0,
  );
  const cgcPoint = Math.min(base, cgcCeil);
  const cgcGrade = toHalf(cgcPoint);
  const cgcPristine =
    weakest >= 9.8 && frontPct <= 52 && backPct <= 60 && !ding.factor;
  const cgc: GradePrediction = {
    grade: cgcGrade,
    gradeRange: rangeFor(cgcPoint, conf, 0.5),
    label: cgcPristine
      ? "CGC Pristine 10"
      : `CGC ${fmtGrade(cgcGrade)} ${tierName(cgcGrade)}`.trim(),
    limitingFactor: bindingFactor(cgcCeil),
    confidence: conf,
    isPristine: cgcPristine,
  };

  // ── TAG — 1000-pt; 950+ = 10, 990+ = Pristine; DINGS + TCG centering cap ──
  const tagCeil1000 = tagCenteringCeiling1000(frontPct, backPct);
  const dingCeil1000 = ding.cap10 * 100; // 8 -> 800 ceiling
  let score1000 = Math.min(computeTpScore(sub) * 10, tagCeil1000, dingCeil1000);
  score1000 = Math.max(100, Math.round(score1000));
  const tagGradeRaw =
    score1000 >= 990
      ? 10
      : score1000 >= 950
        ? 10
        : score1000 >= 900
          ? 9.5
          : score1000 >= 850
            ? 9
            : score1000 / 100;
  const tagGrade = toHalf(tagGradeRaw);
  const tagPristine = score1000 >= 990;
  const tag: GradePrediction & { score1000: number } = {
    grade: tagGrade,
    gradeRange: rangeFor(tagGrade, conf, 0.5),
    label: tagPristine
      ? "TAG 10 Pristine"
      : `TAG ${fmtGrade(tagGrade)} ${tierName(tagGrade)}`.trim(),
    limitingFactor:
      ding.factor ?? (frontPct > 55 ? "centering" : `${weakestName} sub-grade`),
    confidence: conf,
    isPristine: tagPristine,
    score1000,
  };

  return { psa, bgs, cgc, tag };
}

// ─── Stage 1: the Analyst prompt (grade-blind, deep) ──────────────────────────

const GRADING_PROMPT =
  () => `You are a trading-card condition ANALYST. You are given the FRONT and BACK images of a single Pokémon TCG card. Produce an OBJECTIVE physical-condition report ONLY.

CRITICAL RULES:
- DO NOT output any PSA/BGS/CGC/TAG grade, or any 1–10 number. You are measuring, not grading.
- Do not consider the card's identity, rarity, or value. Judge only what you can see.
- For anything you cannot clearly see (micro-fraying, hairline scratches under angled light), LOWER that category's confidence rather than guessing a clean result.

Assess BOTH sides. Report per-corner, per-edge, and each surface defect with its location. Flag DINGS = defects notable enough to materially move a grade (e.g. an edge dent, a deep scratch, a corner ding, an off-centre back), each with a severity and your confidence.

Score each category 0–100 (100 = flawless): centering (50/50≈100, 55/45≈90, 60/40≈80, 65/35≈70, 70/30+ poor), corners, edges, surface. Also give a confidence 0–100 per category (centering is reliable from a photo; surface micro-defects are not).

Return ONLY valid JSON, no markdown:
{
  "centering": {
    "front": { "leftRight": "<a/b>", "topBottom": "<a/b>" },
    "back":  { "leftRight": "<a/b>", "topBottom": "<a/b>" }
  },
  "corners": [ { "side": "front|back", "position": "TL|TR|BL|BR", "score": <0-100>, "whitening": <0-100> } ],
  "edges":   [ { "side": "front|back", "position": "top|bottom|left|right", "score": <0-100>, "whitening": <0-100>, "chipping": <0-100> } ],
  "surface": [ { "side": "front|back", "type": "scratch|print_line|dent|scuff|holo_scratch|stain|gloss_loss|print_defect|other", "severity": <0-100>, "location": "<where>" } ],
  "dimensions": { "heightIn": <number|null>, "widthIn": <number|null> },
  "dings": [ { "side": "front|back", "category": "corner|edge|surface|centering", "location": "<where>", "type": "<short>", "severity": <0-100>, "confidence": <0-100> } ],
  "sub": { "centering": <0-100>, "corners": <0-100>, "edges": <0-100>, "surface": <0-100> },
  "categoryConfidence": { "centering": <0-100>, "corners": <0-100>, "edges": <0-100>, "surface": <0-100> },
  "overallConfidence": <0-100>,
  "strengths": ["<short>"],
  "issues": ["<short>"],
  "notes": "<2-3 sentence objective summary, no grade>"
}`;

// ─── parse Gemini JSON → ObjectiveReport ──────────────────────────────────────

function coerceReport(parsed: any): ObjectiveReport {
  const cm = (side: Side, o: any): CenteringMeasure => {
    const lr = o?.leftRight ?? "50/50";
    const tb = o?.topBottom ?? "50/50";
    return {
      side,
      leftRight: lr,
      topBottom: tb,
      worstAxisPct: worstAxisFromRatios(lr, tb),
    };
  };
  const centering: CenteringMeasure[] = [];
  if (parsed?.centering?.front)
    centering.push(cm("front", parsed.centering.front));
  if (parsed?.centering?.back)
    centering.push(cm("back", parsed.centering.back));

  const sub: SubScores = {
    centering: clamp100(parsed?.sub?.centering ?? 70),
    corners: clamp100(parsed?.sub?.corners ?? 70),
    edges: clamp100(parsed?.sub?.edges ?? 70),
    surface: clamp100(parsed?.sub?.surface ?? 70),
  };

  return {
    centering,
    corners: Array.isArray(parsed?.corners) ? parsed.corners.slice(0, 8) : [],
    edges: Array.isArray(parsed?.edges) ? parsed.edges.slice(0, 8) : [],
    surface: Array.isArray(parsed?.surface) ? parsed.surface.slice(0, 20) : [],
    dimensions: {
      heightIn:
        typeof parsed?.dimensions?.heightIn === "number"
          ? parsed.dimensions.heightIn
          : null,
      widthIn:
        typeof parsed?.dimensions?.widthIn === "number"
          ? parsed.dimensions.widthIn
          : null,
    },
    dings: Array.isArray(parsed?.dings)
      ? parsed.dings.slice(0, 12).map((d: any) => ({
          side: d?.side === "back" ? "back" : "front",
          category: d?.category ?? "surface",
          location: String(d?.location ?? ""),
          type: String(d?.type ?? "defect"),
          severity: clamp100(d?.severity ?? 30),
          confidence: clamp100(d?.confidence ?? 60),
        }))
      : [],
    sub,
    categoryConfidence: {
      centering: clamp100(parsed?.categoryConfidence?.centering ?? 85),
      corners: clamp100(parsed?.categoryConfidence?.corners ?? 65),
      edges: clamp100(parsed?.categoryConfidence?.edges ?? 60),
      surface: clamp100(parsed?.categoryConfidence?.surface ?? 55),
    },
    overallConfidence: clamp100(parsed?.overallConfidence ?? 65),
    strengths: Array.isArray(parsed?.strengths)
      ? parsed.strengths.slice(0, 6)
      : [],
    issues: Array.isArray(parsed?.issues) ? parsed.issues.slice(0, 8) : [],
    notes: String(parsed?.notes ?? ""),
  };
}
// ─── Stage 1 call + assembly ──────────────────────────────────────────────────

export const analyzeCardForGrading = async (
  frontBase64: string,
  frontMime: "image/jpeg" | "image/png" | "image/webp",
  backBase64: string,
  backMime: "image/jpeg" | "image/png" | "image/webp",
  // Card identity is intentionally NOT passed to the analyst — knowing the card
  // is valuable biases it toward the market-expected grade. Params kept for
  // signature compatibility with existing callers; they're ignored on purpose.
  _cardName?: string,
  _setName?: string,
): Promise<GradingAnalysis> => {
  if (!process.env.GEMINI_API_KEY) {
    throw { status: 503, message: "Gemini Vision API not configured" };
  }

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
          { text: GRADING_PROMPT() },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 4096, // deep report JSON is much larger than v1
      responseMimeType: "application/json",
      // @ts-ignore — thinkingConfig is valid for gemini-2.5-flash. Raise the
      // budget here (e.g. 512) if you want deeper defect reasoning at higher cost.
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
      throw new Error(`No JSON object found. Raw: ${raw.substring(0, 200)}`);
    }
    parsed = JSON.parse(stripped.substring(start, end + 1));
  } catch (err: any) {
    await logError({
      source: "ai-grading",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    throw new Error(`Failed to parse Gemini grading response: ${err?.message}`);
  }

  const report = coerceReport(parsed);
  const tpScore = computeTpScore(report.sub);
  const predictions = predictGrades(report);

  const front = report.centering.find((c) => c.side === "front");
  const back = report.centering.find((c) => c.side === "back");

  return {
    tpScore,
    tpDisplay: Math.round((tpScore / 10) * 10) / 10,
    sub: report.sub,
    report,
    predictions,
    // Back-compat fields for the current UI (Phase-3 replaces these):
    centeringRatio: {
      front: front ? `${front.leftRight} · ${front.topBottom}` : "Unknown",
      back: back ? `${back.leftRight} · ${back.topBottom}` : null,
    },
    issues: report.issues,
    strengths: report.strengths,
    confidence: report.overallConfidence,
    notes: report.notes,
  };
};

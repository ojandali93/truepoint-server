import {
  GoogleGenerativeAI,
  Part,
  HarmCategory,
  HarmBlockThreshold,
} from "@google/generative-ai";

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

  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
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

export interface GradingAnalysis {
  // Sub-grades (1-10 in 0.5 increments)
  centering: number;
  corners: number;
  edges: number;
  surface: number;

  // Predicted grades per company
  predictions: {
    psa: { grade: number; label: string };
    bgs: { grade: number; label: string; isBlackLabel: boolean };
    cgc: { grade: number; label: string; isPristine: boolean };
    tag: { grade: number; label: string; isPristine: boolean };
  };

  centeringRatio: { front: string; back: string | null };
  issues: string[];
  strengths: string[];
  confidence: number; // 0-100
  notes: string;
}

// ─── Grade calculation (based on official published standards) ────────────────

const clamp = (v: number) => Math.max(1, Math.min(10, Math.round(v * 2) / 2));

const calcPSA = (c: number, co: number, e: number, s: number) => {
  const avg = (c + co + e + s) / 4;
  if (avg >= 9.8 && c >= 9.5 && co >= 9.5 && e >= 9.5 && s >= 9.5)
    return { grade: 10, label: "PSA 10 Gem Mint" };
  if (avg >= 9.0) return { grade: 9, label: "PSA 9 Mint" };
  if (avg >= 8.5) return { grade: 8, label: "PSA 8 Near Mint-Mint" };
  if (avg >= 7.5) return { grade: 7, label: "PSA 7 Near Mint" };
  if (avg >= 6.5) return { grade: 6, label: "PSA 6 Excellent-Mint" };
  if (avg >= 5.5) return { grade: 5, label: "PSA 5 Excellent" };
  if (avg >= 4.5) return { grade: 4, label: "PSA 4 Very Good-Excellent" };
  if (avg >= 3.5) return { grade: 3, label: "PSA 3 Very Good" };
  if (avg >= 2.5) return { grade: 2, label: "PSA 2 Good" };
  return { grade: 1, label: "PSA 1 Poor" };
};

const calcBGS = (c: number, co: number, e: number, s: number) => {
  const subs = [c, co, e, s];
  const lowest = Math.min(...subs);
  const avg = subs.reduce((a, b) => a + b, 0) / 4;
  const count10 = subs.filter((v) => v === 10).length;
  const countAbove95 = subs.filter((v) => v >= 9.5).length;

  // BGS Black Label: ALL four must be 10, centering exactly 50/50
  if (subs.every((v) => v === 10)) {
    return { grade: 10, label: "BGS 10 Black Label", isBlackLabel: true };
  }
  // BGS 10 Pristine (Gold Label): all ≥9.5, three must be 10
  if (subs.every((v) => v >= 9.5) && count10 >= 3) {
    return {
      grade: 10,
      label: "BGS 10 Pristine (Gold Label)",
      isBlackLabel: false,
    };
  }
  // BGS 9.5 Gem Mint: all ≥9, three must be 9.5+
  if (subs.every((v) => v >= 9) && countAbove95 >= 3) {
    return { grade: 9.5, label: "BGS 9.5 Gem Mint", isBlackLabel: false };
  }
  if (lowest >= 9)
    return { grade: 9, label: "BGS 9 Mint", isBlackLabel: false };
  if (lowest >= 8.5)
    return { grade: 8.5, label: "BGS 8.5", isBlackLabel: false };
  if (lowest >= 8)
    return { grade: 8, label: "BGS 8 Near Mint-Mint", isBlackLabel: false };
  if (lowest >= 7.5)
    return { grade: 7.5, label: "BGS 7.5", isBlackLabel: false };
  if (lowest >= 7)
    return { grade: 7, label: "BGS 7 Near Mint", isBlackLabel: false };
  if (avg >= 6)
    return { grade: 6, label: "BGS 6 Excellent-Mint", isBlackLabel: false };
  if (avg >= 5)
    return { grade: 5, label: "BGS 5 Excellent", isBlackLabel: false };
  return {
    grade: Math.max(1, Math.round(avg)),
    label: `BGS ${Math.max(1, Math.round(avg))}`,
    isBlackLabel: false,
  };
};

const calcCGC = (c: number, co: number, e: number, s: number) => {
  const avg = (c + co + e + s) / 4;
  // CGC Pristine 10: 50/50 centering (c=10), virtually flawless everything
  if (c >= 9.8 && co >= 9.5 && e >= 9.5 && s >= 9.5 && avg >= 9.7) {
    return { grade: 10, label: "CGC Pristine 10", isPristine: true };
  }
  // CGC Gem Mint 10: centering up to 55/45 (c≥9), perfect corners/edges/surface
  if (avg >= 9.4 && co >= 9 && e >= 9 && s >= 9) {
    return { grade: 10, label: "CGC Gem Mint 10", isPristine: false };
  }
  if (avg >= 9.2)
    return { grade: 9.5, label: "CGC Mint+ 9.5", isPristine: false };
  if (avg >= 8.7) return { grade: 9, label: "CGC Mint 9", isPristine: false };
  if (avg >= 8.2)
    return { grade: 8.5, label: "CGC Near Mint+ 8.5", isPristine: false };
  if (avg >= 7.7)
    return { grade: 8, label: "CGC Near Mint-Mint 8", isPristine: false };
  if (avg >= 7.2)
    return { grade: 7.5, label: "CGC Near Mint+ 7.5", isPristine: false };
  if (avg >= 6.7)
    return { grade: 7, label: "CGC Near Mint 7", isPristine: false };
  if (avg >= 6)
    return { grade: 6, label: "CGC Excellent+ 6", isPristine: false };
  return {
    grade: Math.max(1, Math.floor(avg)),
    label: `CGC ${Math.max(1, Math.floor(avg))}`,
    isPristine: false,
  };
};

const calcTAG = (c: number, co: number, e: number, s: number) => {
  const avg = (c + co + e + s) / 4;
  // TAG Pristine: ~51/49 TCG centering (c≈10), only NHODs allowed
  if (c >= 9.9 && co >= 9.5 && e >= 9.5 && s >= 9.5) {
    return { grade: 10, label: "TAG Pristine 10", isPristine: true };
  }
  if (avg >= 9.3 && Math.min(c, co, e, s) >= 9) {
    return { grade: 10, label: "TAG 10", isPristine: false };
  }
  if (avg >= 9.0) return { grade: 9.5, label: "TAG 9.5", isPristine: false };
  if (avg >= 8.5) return { grade: 9, label: "TAG 9", isPristine: false };
  if (avg >= 8.0) return { grade: 8.5, label: "TAG 8.5", isPristine: false };
  if (avg >= 7.5) return { grade: 8, label: "TAG 8", isPristine: false };
  if (avg >= 7.0) return { grade: 7, label: "TAG 7", isPristine: false };
  return {
    grade: Math.max(1, Math.round(avg)),
    label: `TAG ${Math.max(1, Math.round(avg))}`,
    isPristine: false,
  };
};

const GRADING_PROMPT = (
  cardContext: string,
) => `You are an expert Pokémon TCG card grading specialist with 20+ years of experience grading for PSA, BGS, CGC, and TAG. ${cardContext}

Analyze this card image with the precision of a professional grader. Examine all four criteria:

CENTERING — measure border ratios left/right and top/bottom:
10 = exactly 50/50 | 9.5 = 52/48 | 9 = 55/45 | 8.5 = 58/42 | 8 = 60/40 | 7.5 = 62/38 | 7 = 65/35

CORNERS — inspect all four for sharpness, fraying, rounding, whitening, dings:
10 = perfectly sharp, flawless under magnification | 9.5 = sharp, very minor imperfection under magnification only
9 = sharp to naked eye, slight under magnification | 8.5 = very minor corner touch under close inspection
8 = minor wear under close inspection | 7.5 = light fraying visible | 7 = noticeable wear or fraying

EDGES — all four edges for chipping, whitening, roughness, nicks:
10 = perfectly smooth, no flaws under magnification | 9.5 = virtually flawless, minor artifacts under magnification
9 = virtually mint, a speck of wear allowed | 8.5 = minor edge wear under close inspection
8 = slight chipping or roughness | 7.5 = some chipping | 7 = noticeable roughness or multiple chips

SURFACE — front and back for scratches, print lines, holo scratches, dents, fingerprints, gloss issues:
10 = flawless, perfect gloss | 9.5 = near flawless, barely visible minor print spot under magnification
9 = very minor print spots under scrutiny only | 8.5 = a few very minor print spots or one tiny scratch
8 = minor scratches or print spots under close inspection | 7.5 = light scratches or multiple print spots | 7 = visible scratches

Return ONLY valid JSON — no markdown, no code blocks:
{
  "centering": <1-10 in 0.5 increments>,
  "corners": <1-10 in 0.5 increments>,
  "edges": <1-10 in 0.5 increments>,
  "surface": <1-10 in 0.5 increments>,
  "centering_ratio_front": "<e.g. '52/48'>",
  "centering_ratio_back": "<e.g. '60/40' or null>",
  "issues": ["<specific defect>"],
  "strengths": ["<what looks great>"],
  "confidence": <0-100>,
  "notes": "<2-3 sentence overall assessment>"
}

Be precise and conservative — like a real grader. If image quality is poor, lower your confidence score.`;

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
    model: "gemini-2.0-flash",
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
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  });

  const raw = result.response.text().trim();

  let parsed: any;
  try {
    parsed = JSON.parse(raw.replace(/```json\n?|```\n?/g, "").trim());
  } catch {
    throw new Error("Failed to parse Gemini grading response");
  }

  const c = clamp(parsed.centering ?? 7);
  const co = clamp(parsed.corners ?? 7);
  const e = clamp(parsed.edges ?? 7);
  const s = clamp(parsed.surface ?? 7);

  return {
    centering: c,
    corners: co,
    edges: e,
    surface: s,
    predictions: {
      psa: calcPSA(c, co, e, s),
      bgs: calcBGS(c, co, e, s),
      cgc: calcCGC(c, co, e, s),
      tag: calcTAG(c, co, e, s),
    },
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

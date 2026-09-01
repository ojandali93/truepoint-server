// src/services/counterfeitScreening.service.ts
//
// Orchestrates a counterfeit screen (Phase 0 — see
// AUDITS/counterfeit-screening-plan.md): identify the card from the front
// photo (reusing cardIdentification.service.ts as-is, no new identification
// logic), fetch the catalog reference image when identification is
// confident enough to trust, then run the counterfeit-screening Gemini
// prompt (geminiClient.ts) with whatever photos + reference are available.
//
// Phase 0 scope: this function only. No HTTP route, no controller, no
// client wiring, no metering — those are Phase 1/2 per the plan doc.
// Exercised directly by scripts/validateCounterfeitCalibration.ts for now.

import axios from "axios";
import {
  analyzeCardForCounterfeits,
  CounterfeitScreeningAnalysis,
} from "../lib/geminiClient";
import { identifyFromBase64 } from "./cardIdentification.service";
import { logError } from "../lib/Logger";

export interface IdentifiedCardSummary {
  name: string | null;
  setName: string | null;
  cardNumber: string | null;
  matchConfidence: "exact" | "probable" | "unverified" | "failed";
}

export interface CounterfeitScreenResult {
  identifiedCard: IdentifiedCardSummary;
  referenceImageUsed: boolean;
  backlitIncluded: boolean;
  analysis: CounterfeitScreeningAnalysis;
  concernCount: number; // findings with severity "concerning" or "strong"
  topLineResult: string;
}

const SEVERITY_CONCERN = new Set(["concerning", "strong"]);

// Downloads a reference image URL (cards.image_small/image_large — a real
// TCGplayer CDN URL, verified live during the image-caching-audit session)
// and returns it as base64 for the Gemini call. Returns null on any
// failure rather than throwing — a broken reference fetch should degrade
// to "no reference," not fail the whole screen.
const fetchReferenceImage = async (
  url: string,
): Promise<{ base64: string; mime: "image/jpeg" | "image/png" | "image/webp" } | null> => {
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      timeout: 15000,
    });
    const contentType = String(res.headers["content-type"] ?? "image/jpeg");
    const mime: "image/jpeg" | "image/png" | "image/webp" = contentType.includes(
      "png",
    )
      ? "image/png"
      : contentType.includes("webp")
        ? "image/webp"
        : "image/jpeg";
    return { base64: Buffer.from(res.data).toString("base64"), mime };
  } catch (err: any) {
    await logError({
      source: "counterfeit-screening-reference-fetch",
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: url,
      requestMethod: "GET",
      metadata: {},
    });
    return null;
  }
};

export const screenCardForCounterfeits = async (images: {
  frontBase64: string;
  frontMime: "image/jpeg" | "image/png" | "image/webp";
  backBase64: string;
  backMime: "image/jpeg" | "image/png" | "image/webp";
  backlitBase64?: string;
  backlitMime?: "image/jpeg" | "image/png" | "image/webp";
}): Promise<CounterfeitScreenResult> => {
  // Step 1: identify the card from the front photo — reuses the existing
  // identify/catalog-match pipeline wholesale, per the plan doc's "this
  // already exists, don't rebuild it" call.
  const scan = await identifyFromBase64(images.frontBase64, images.frontMime);

  const identifiedCard: IdentifiedCardSummary = {
    name: scan.matchedCard?.name ?? scan.identification.cardName,
    setName: scan.matchedCard?.set?.name ?? scan.identification.setName,
    cardNumber: scan.matchedCard?.number ?? scan.identification.cardNumber,
    matchConfidence: scan.matchConfidence,
  };

  // Step 2: only trust a reference image on exact/probable — unverified/
  // failed matches get no reference, per the plan doc's abstention design
  // (a wrong reference is worse than no reference).
  const referenceUrl =
    (scan.matchConfidence === "exact" || scan.matchConfidence === "probable") &&
    scan.matchedCard?.images?.large
      ? scan.matchedCard.images.large
      : (scan.matchConfidence === "exact" || scan.matchConfidence === "probable")
        ? (scan.matchedCard?.images?.small ?? null)
        : null;

  const reference = referenceUrl ? await fetchReferenceImage(referenceUrl) : null;

  // Step 3: run the screening prompt with whatever we have.
  const analysis = await analyzeCardForCounterfeits(
    images,
    reference,
    identifiedCard.name ?? undefined,
    identifiedCard.setName ?? undefined,
  );

  const concernCount = analysis.findings.filter((f) =>
    SEVERITY_CONCERN.has(f.severity),
  ).length;

  const topLineResult =
    concernCount > 0
      ? `${concernCount} concern${concernCount === 1 ? "" : "s"} found`
      : "No red flags detected in these photos — this is a screen, not an authentication.";

  return {
    identifiedCard,
    referenceImageUsed: !!reference,
    backlitIncluded: !!images.backlitBase64,
    analysis,
    concernCount,
    topLineResult,
  };
};

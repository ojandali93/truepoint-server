// src/lib/cardsightClient.ts
// CardSight AI — visual card identification.
//   POST https://api.cardsight.ai/v1/identify/card
//   Header: X-API-Key: <key without hyphens>
//   Body:   multipart/form-data, field "image"
//   Resp:   { success, requestId, detections: [{ confidence, card }], processingTime }
//
// The `card` object carries name / releaseName (set) / number / fields — but NO
// TCGPlayer id, so scan.service maps it onto our cards table by name+number+set.
//
// NOTE: uses Node 18+ global FormData/Blob (Render runs Node 18/20), so no
// extra dependency. Store CARDSIGHT_API_KEY in env; hyphens are stripped here.

import axios from "axios";

const CARDSIGHT_IDENTIFY_URL = "https://api.cardsight.ai/v1/identify/card";

export interface CardSightField {
  name?: string;
  value?: string;
  [k: string]: unknown;
}
export interface CardSightCard {
  id?: string | number;
  name?: string;
  releaseName?: string; // set / release name
  number?: string;
  fields?: CardSightField[];
  [k: string]: unknown;
}
export interface CardSightDetection {
  confidence?: string; // "High" | "Medium" | "Low"
  card?: CardSightCard;
  [k: string]: unknown;
}
export interface CardSightIdentifyResponse {
  success: boolean;
  requestId?: string;
  detections?: CardSightDetection[];
  processingTime?: number;
}

export async function identifyCard(
  base64: string,
  mime = "image/jpeg",
): Promise<CardSightIdentifyResponse> {
  const apiKey = (process.env.CARDSIGHT_API_KEY ?? "").replace(/-/g, "");
  if (!apiKey) throw new Error("CARDSIGHT_API_KEY is not configured");

  const buffer = Buffer.from(base64, "base64");
  const form = new FormData();
  form.append("image", new Blob([buffer], { type: mime }), "card.jpg");

  const res = await axios.post<CardSightIdentifyResponse>(
    CARDSIGHT_IDENTIFY_URL,
    form,
    {
      headers: { "X-API-Key": apiKey },
      timeout: 20000,
      maxBodyLength: Infinity,
    },
  );
  return res.data;
}
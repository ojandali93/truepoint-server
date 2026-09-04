// src/lib/ximilarClient.ts
// Ximilar Collectibles Recognition — TCG card identification.
//   POST https://api.ximilar.com/collectibles/v2/tcg_id
//   Header: Authorization: Token <XIMILAR_API_TOKEN>
//   Body:   application/json  { records: [{ _base64: "<base64>" }], rotate: true }
//
// NOTE: tcg_id requires a paid Ximilar plan (Business tier) with Collectibles
// Recognition enabled + available credits. A token alone is not enough — an
// unprovisioned/credit-less token returns HTTP 401/402/403, which previously
// surfaced only as a generic "Request failed with status code XXX". This client
// now extracts Ximilar's status + body into the thrown error so the real reason
// shows up in Error Logs, and also checks Ximilar's per-record status codes.

import axios, { AxiosError } from "axios";

const XIMILAR_TCG_URL = "https://api.ximilar.com/collectibles/v2/tcg_id";

export interface XimilarMatch {
  name?: string;
  full_name?: string;
  set?: string;
  set_code?: string;
  series?: string;
  card_number?: string;
  out_of?: string;
  rarity?: string;
  year?: number | string;
  subcategory?: string;
  links?: Record<string, string>;
  [k: string]: unknown;
}

export interface XimilarIdentification {
  bestMatch: XimilarMatch | null;
  alternatives: XimilarMatch[];
  distance: number | null;
  subcategory: string | null;
  foil: boolean;
}

const EMPTY: XimilarIdentification = {
  bestMatch: null,
  alternatives: [],
  distance: null,
  subcategory: null,
  foil: false,
};

const cleanBase64 = (b64: string): string =>
  b64.replace(/^data:[^;]+;base64,/, "");

// ─── Card Grading (dual-engine comparison, admin-only — AUDITS/dual-engine-grading-plan.md) ─
//
// Ximilar's card-grader is asynchronous ONLY — there is no synchronous grading
// endpoint. Submit once (records = both sides in one request), then poll the
// returned id until status: "DONE". Confirmed live 2026-09-04 (see plan doc §3):
// submitting front+back together returns TWO per-side records (not one combined
// record), each self-identifying via card[0]._tags.Side ("Front"/"Back") — read
// that tag, never assume array order. There is no combined/weighted `final` in
// the response despite the docs mentioning a 70/30 front/back default elsewhere;
// gradeCardOverall() below computes it the same way ourselves.
//
// No credits/cost field appears anywhere in this response (confirmed via docs
// and the live probe) — callers log a flat constant instead, see
// XIMILAR_GRADE_CREDIT_COST in aiGrading.controller.ts.

const XIMILAR_REQUEST_URL = "https://api.ximilar.com/account/v2/request/";

export interface XimilarCenteringDetail {
  grade: number;
  leftRight: string; // e.g. "41/59"
  topBottom: string; // e.g. "52/48"
  pixels: number[];
  offsets: number[];
}

export interface XimilarSideGrades {
  side: "Front" | "Back" | "Unknown";
  grades: {
    centering: number;
    corners: number;
    edges: number;
    surface: number;
    final: number;
    condition: string | null;
  };
  centering: XimilarCenteringDetail | null;
}

export interface XimilarGradeResult {
  requestId: string;
  front: XimilarSideGrades | null;
  back: XimilarSideGrades | null;
  overall: number | null; // 0.7*front.final + 0.3*back.final — Ximilar never returns this itself
  raw: unknown; // full DONE response, unshaped — see grading_engine_comparisons.ximilar_raw
}

/** Submit a front+back pair. Returns Ximilar's own request id — the caller owns polling/timeout. */
export async function submitCardGrade(
  frontBase64: string,
  backBase64: string,
): Promise<string> {
  const token = (process.env.XIMILAR_API_TOKEN ?? "").trim();
  if (!token) throw new Error("XIMILAR_API_TOKEN is not configured");

  let res;
  try {
    res = await axios.post(
      XIMILAR_REQUEST_URL,
      {
        type: "card-grader",
        endpoint: "grade",
        records: [
          { _base64: cleanBase64(frontBase64) },
          { _base64: cleanBase64(backBase64) },
        ],
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${token}`,
        },
        timeout: 30000,
        maxBodyLength: Infinity,
        validateStatus: () => true,
      },
    );
  } catch (err) {
    const ae = err as AxiosError;
    throw new Error(
      `Ximilar submit failed (no response): ${ae.code ?? ""} ${ae.message}`.trim(),
    );
  }

  if (res.status < 200 || res.status >= 300) {
    const body =
      typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});
    throw new Error(`Ximilar submit error (HTTP ${res.status}): ${body.slice(0, 500)}`);
  }

  const id = res.data?.id;
  if (!id) throw new Error("Ximilar submit response had no request id");
  return id;
}

/** One poll attempt. Returns null while still processing; the caller owns the retry loop + timeout. */
export async function pollCardGrade(
  requestId: string,
): Promise<XimilarGradeResult | null> {
  const token = (process.env.XIMILAR_API_TOKEN ?? "").trim();
  if (!token) throw new Error("XIMILAR_API_TOKEN is not configured");

  let res;
  try {
    res = await axios.get(`${XIMILAR_REQUEST_URL}${requestId}`, {
      headers: { Authorization: `Token ${token}` },
      timeout: 15000,
      validateStatus: () => true,
    });
  } catch (err) {
    const ae = err as AxiosError;
    throw new Error(
      `Ximilar poll failed (no response): ${ae.code ?? ""} ${ae.message}`.trim(),
    );
  }

  if (res.status < 200 || res.status >= 300) {
    const body =
      typeof res.data === "string" ? res.data : JSON.stringify(res.data ?? {});
    throw new Error(`Ximilar poll error (HTTP ${res.status}): ${body.slice(0, 500)}`);
  }

  const status = res.data?.status;
  if (status === "FAILED" || status === "ERROR") {
    throw new Error(`Ximilar processing failed: ${JSON.stringify(res.data).slice(0, 500)}`);
  }
  if (status !== "DONE") return null; // still CREATED/PROCESSING — caller polls again

  const records: any[] = res.data?.response?.records ?? [];

  const toSideGrades = (record: any): XimilarSideGrades | null => {
    const card = record?.card?.[0];
    if (!card || !record?.grades) return null;
    const sideTag = card?._tags?.Side?.[0]?.name;
    const side: XimilarSideGrades["side"] =
      sideTag === "Front" ? "Front" : sideTag === "Back" ? "Back" : "Unknown";
    const c = card.centering;
    const centering: XimilarCenteringDetail | null = c
      ? {
          grade: c.grade,
          leftRight: c["left/right"],
          topBottom: c["top/bottom"],
          pixels: c.pixels ?? [],
          offsets: c.offsets ?? [],
        }
      : null;
    return {
      side,
      grades: {
        centering: record.grades.centering,
        corners: record.grades.corners,
        edges: record.grades.edges,
        surface: record.grades.surface,
        final: record.grades.final,
        condition: record.grades.condition ?? null,
      },
      centering,
    };
  };

  const parsed = records.map(toSideGrades).filter((r): r is XimilarSideGrades => r !== null);
  const front = parsed.find((r) => r.side === "Front") ?? null;
  const back = parsed.find((r) => r.side === "Back") ?? null;

  const overall =
    front && back ? 0.7 * front.grades.final + 0.3 * back.grades.final : null;

  return { requestId, front, back, overall, raw: res.data };
}

export async function identifyCard(
  base64: string,
): Promise<XimilarIdentification> {
  const token = (process.env.XIMILAR_API_TOKEN ?? "").trim();
  if (!token) throw new Error("XIMILAR_API_TOKEN is not configured");

  let res;
  try {
    res = await axios.post(
      XIMILAR_TCG_URL,
      {
        records: [{ _base64: cleanBase64(base64) }],
        rotate: true,
      },
      {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Token ${token}`,
        },
        timeout: 25000,
        maxBodyLength: Infinity,
        // Don't let axios throw before we can read Ximilar's error body.
        validateStatus: () => true,
      },
    );
  } catch (err) {
    // Network/timeout (no HTTP response at all).
    const ae = err as AxiosError;
    throw new Error(
      `Ximilar request failed (no response): ${ae.code ?? ""} ${ae.message}`.trim(),
    );
  }

  // HTTP-level error from Ximilar (auth / plan / credits / bad request).
  if (res.status < 200 || res.status >= 300) {
    const body =
      typeof res.data === "string"
        ? res.data
        : JSON.stringify(res.data ?? {});
    throw new Error(
      `Ximilar API error (HTTP ${res.status}): ${body.slice(0, 500)}`,
    );
  }

  // Top-level processing status (Ximilar can return 200 with a non-200 status).
  const topStatus = res.data?.status;
  if (topStatus && typeof topStatus.code === "number" && topStatus.code >= 300) {
    throw new Error(
      `Ximilar processing error (${topStatus.code}): ${topStatus.text ?? "unknown"}`,
    );
  }

  const record = res.data?.records?.[0];
  if (!record) return EMPTY;

  // Per-record status (e.g. image decode failure, credit issue on that record).
  const recStatus = record._status;
  if (recStatus && typeof recStatus.code === "number" && recStatus.code >= 300) {
    throw new Error(
      `Ximilar record error (${recStatus.code}): ${recStatus.text ?? "unknown"}`,
    );
  }

  const objects: any[] = Array.isArray(record._objects) ? record._objects : [];
  const cardObj =
    objects.find((o) => o?.name === "Card") ??
    objects.find((o) => o?.["Top Category"]?.[0]?.name === "Card") ??
    null;

  if (!cardObj) return EMPTY;

  const ident = cardObj._identification ?? {};
  const bestMatch: XimilarMatch | null = ident.best_match ?? null;
  const alternatives: XimilarMatch[] = Array.isArray(ident.alternatives)
    ? ident.alternatives
    : [];
  const distance: number | null = Array.isArray(ident.distances)
    ? (ident.distances[0] ?? null)
    : null;

  const tags = cardObj._tags ?? {};
  const subcategory: string | null =
    tags?.Subcategory?.[0]?.name ?? bestMatch?.subcategory ?? null;
  const foil = String(tags?.["Foil/Holo"]?.[0]?.name ?? "")
    .toLowerCase()
    .includes("foil");

  return { bestMatch, alternatives, distance, subcategory, foil };
}
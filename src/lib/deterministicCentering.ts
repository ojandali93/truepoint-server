// src/lib/deterministicCentering.ts
//
// Deterministic centering fusion for AI grading (2026-09 perception fix).
// The failure this exists to close: centering was entirely the model's own
// visual estimate — no independent check — and a real production report
// got a literal "50/50" on a back face whose photo shows an asymmetric
// border. The fix is not a better prompt; it's removing centering from the
// model's job whenever we can measure it for real.
//
// Geometry math (border positions -> percentages) is NOT reimplemented
// here — it's the exact same calculateMeasurements/calculatePercentages
// centeringEngine.ts already uses for the standalone Centering tool. DPI
// cancels out of every percentage this module reads (leftPct is
// leftMm/(leftMm+rightMm), and both sides scale by the same
// pixelsPerMm) so an arbitrary constant DPI is correct here, not a
// shortcut — see calculateMeasurements.
//
// Border DETECTION (OpenCV, on-device) lives on mobile
// (src/lib/detectCardBorders.ts) and is not reproducible server-side; this
// module only trusts geometry mobile already flagged "high" confidence.
// Anything else — no geometry, "medium"/"low" confidence, or malformed
// input — is treated as UNMEASURED, never silently defaulted to a
// mid-range guess.

import { calculateMeasurements, calculatePercentages } from "./centeringEngine";
import { BorderPositions } from "../types/centering.types";

const ARBITRARY_DPI = 300; // cancels out of every percentage this module computes — see header

export interface CenteringGeometry {
  borders: BorderPositions;
  imageWidth: number;
  imageHeight: number;
  confidence: "high" | "medium" | "low";
}

export interface MeasuredCentering {
  ratio: string; // e.g. "55.2/44.8" — the worse axis, larger side first
  worstAxisPct: number; // the larger side of the worse axis, as a raw number
}

const isFiniteNum = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n);

const validGeometry = (g: CenteringGeometry): boolean => {
  const b = g.borders;
  if (!b) return false;
  const vals = [
    b.outerLeft, b.outerRight, b.outerTop, b.outerBottom,
    b.innerLeft, b.innerRight, b.innerTop, b.innerBottom,
  ];
  if (!vals.every(isFiniteNum)) return false;
  if (!isFiniteNum(g.imageWidth) || !isFiniteNum(g.imageHeight)) return false;
  if (g.imageWidth <= 0 || g.imageHeight <= 0) return false;
  // Same ordering sanity check centeringEngine's own validateBorders
  // applies for the standalone tool — a geometry that fails this is
  // nonsense (e.g. inner outside outer) regardless of what confidence
  // mobile attached to it.
  return (
    b.outerLeft < b.innerLeft &&
    b.innerLeft < b.innerRight &&
    b.innerRight < b.outerRight &&
    b.outerTop < b.innerTop &&
    b.innerTop < b.innerBottom &&
    b.innerBottom < b.outerBottom
  );
};

/**
 * Returns a deterministic measurement ONLY when mobile reported "high"
 * confidence AND the geometry is internally sane. Everything else — no
 * geometry object, "medium"/"low" confidence, malformed borders — returns
 * null, meaning: this face's centering is UNMEASURED, not "measured as
 * roughly centered." Callers must abstain, not default to 50/50.
 */
export function measureCentering(
  geometry: CenteringGeometry | null | undefined,
): MeasuredCentering | null {
  if (!geometry || geometry.confidence !== "high") return null;
  if (!validGeometry(geometry)) return null;

  const measurements = calculateMeasurements(
    geometry.borders,
    geometry.imageWidth,
    geometry.imageHeight,
    ARBITRARY_DPI,
  );
  const pct = calculatePercentages(measurements);

  // Format the worse axis as "<larger>/<smaller>", matching the
  // "60/40"-style strings the rest of the grading pipeline (and the
  // model's own prior self-reports) already use.
  const lrIsWorse = pct.lrWorse >= pct.tbWorse;
  const largerPct = lrIsWorse
    ? Math.max(pct.leftPct, pct.rightPct)
    : Math.max(pct.topPct, pct.bottomPct);
  const smallerPct = 100 - largerPct;

  return {
    ratio: `${largerPct.toFixed(1)}/${smallerPct.toFixed(1)}`,
    worstAxisPct: largerPct,
  };
}

// Piecewise-linear interpolation over the same anchor points the grading
// prompt has always told the model to use for its own centering score
// (50/50 ~= 100, 55/45 ~= 92, 60/40 ~= 84, 65/35 ~= 74, 70/30 ~= 64,
// continuing the ~70/30 slope beyond that) — a deterministic equivalent of
// what the model was estimating, so sub.centering's meaning doesn't shift
// just because the input source did.
const ANCHORS: [number, number][] = [
  [50, 100],
  [55, 92],
  [60, 84],
  [65, 74],
  [70, 64],
];
const TAIL_SLOPE = (64 - 74) / (70 - 65); // continue the last segment's slope past 70

export function centeringPctToScore(worstAxisPct: number): number {
  const pct = Math.max(50, worstAxisPct);
  for (let i = 0; i < ANCHORS.length - 1; i++) {
    const [p0, s0] = ANCHORS[i];
    const [p1, s1] = ANCHORS[i + 1];
    if (pct <= p1) {
      const t = (pct - p0) / (p1 - p0);
      return Math.round(s0 + t * (s1 - s0));
    }
  }
  const [lastP, lastS] = ANCHORS[ANCHORS.length - 1];
  const score = lastS + (pct - lastP) * TAIL_SLOPE;
  return Math.max(1, Math.round(score));
}

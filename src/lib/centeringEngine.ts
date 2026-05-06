import {
  BorderPositions,
  BorderMeasurements,
  CenteringPercentages,
  GradePredictions,
} from "../types/centering.types";

// ─── Measurements ─────────────────────────────────────────────────────────────

export const calculateMeasurements = (
  borders: BorderPositions,
  imageWidth: number,
  imageHeight: number,
  dpi: number,
): BorderMeasurements => {
  const pixelsPerMm = dpi / 25.4;

  const leftPx = (borders.innerLeft - borders.outerLeft) * imageWidth;
  const rightPx = (borders.outerRight - borders.innerRight) * imageWidth;
  const topPx = (borders.innerTop - borders.outerTop) * imageHeight;
  const botPx = (borders.outerBottom - borders.innerBottom) * imageHeight;

  return {
    leftMm: leftPx / pixelsPerMm,
    rightMm: rightPx / pixelsPerMm,
    topMm: topPx / pixelsPerMm,
    bottomMm: botPx / pixelsPerMm,
  };
};

// ─── Centering Percentages ────────────────────────────────────────────────────

export const calculatePercentages = (
  measurements: BorderMeasurements,
): CenteringPercentages => {
  const { leftMm, rightMm, topMm, bottomMm } = measurements;

  const totalLr = leftMm + rightMm;
  const totalTb = topMm + bottomMm;

  const leftPct = totalLr > 0 ? (leftMm / totalLr) * 100 : 50;
  const rightPct = totalLr > 0 ? (rightMm / totalLr) * 100 : 50;
  const topPct = totalTb > 0 ? (topMm / totalTb) * 100 : 50;
  const botPct = totalTb > 0 ? (bottomMm / totalTb) * 100 : 50;

  const lrWorse = Math.max(leftPct, rightPct);
  const tbWorse = Math.max(topPct, botPct);
  const worstAxis = Math.max(lrWorse, tbWorse);

  return {
    leftPct: round(leftPct, 2),
    rightPct: round(rightPct, 2),
    topPct: round(topPct, 2),
    bottomPct: round(botPct, 2),
    lrWorse: round(lrWorse, 2),
    tbWorse: round(tbWorse, 2),
    worstAxis: round(worstAxis, 2),
  };
};

// ─── TruePoint Score ──────────────────────────────────────────────────────────
// Weighted composite on a 0–100 scale (100 = perfect 50/50 on both axes)
// Weighting: worst axis 50%, L/R 25%, T/B 25%
// Deviation from perfect (50) is penalized proportionally

export const calculateTruepointScore = (p: CenteringPercentages): number => {
  const perfectDeviation = 0;
  const worstPossible = 50; // max deviation from 50

  const lrDeviation = Math.abs(p.lrWorse - 50);
  const tbDeviation = Math.abs(p.tbWorse - 50);
  const worstDeviation = Math.abs(p.worstAxis - 50);

  // Weighted penalty (0 = perfect, 50 = worst possible)
  const weightedPenalty =
    worstDeviation * 0.5 + lrDeviation * 0.25 + tbDeviation * 0.25;

  // Convert to 0–100 score (100 = perfect)
  const score = 100 - (weightedPenalty / worstPossible) * 100;
  return round(Math.max(0, Math.min(100, score)), 2);
};

// ─── Grade Predictions ────────────────────────────────────────────────────────
// Based on worst axis — matches original Python logic exactly

const getPsaGrade = (worse: number): string => {
  if (worse <= 55) return "10 (Gem Mint)";
  if (worse <= 60) return "9 (Mint)";
  if (worse <= 65) return "8 (NM-MT)";
  if (worse <= 70) return "7 (NM)";
  if (worse <= 75) return "6 (EX-MT)";
  if (worse <= 80) return "5 (EX)";
  return "4 or lower";
};

const getBgsGrade = (worse: number): string => {
  if (worse <= 50) return "10 (Pristine)";
  if (worse <= 52) return "9.5 (Gem Mint)";
  if (worse <= 55) return "9 (Mint)";
  if (worse <= 60) return "8.5 (NM-MT+)";
  if (worse <= 65) return "8 (NM-MT)";
  if (worse <= 70) return "7.5 (NM+)";
  return "7 or lower";
};

const getCgcGrade = (worse: number): string => {
  if (worse <= 55) return "10 (Pristine)";
  if (worse <= 60) return "9.5 (Gem Mint)";
  if (worse <= 65) return "9 (Mint)";
  if (worse <= 70) return "8.5 (NM-MT+)";
  return "8 or lower";
};

const getSgcGrade = (worse: number): string => {
  if (worse <= 50) return "10 (Pristine)";
  if (worse <= 55) return "10 (Gem Mint)";
  if (worse <= 60) return "9.5 (Mint+)";
  if (worse <= 65) return "9 (Mint)";
  return "8.5 or lower";
};

// TAG uses same centering standard as PSA but with half-point grades
const getTagGrade = (worse: number): string => {
  if (worse <= 50) return "10 (Gem Mint)";
  if (worse <= 55) return "9.5 (Mint+)";
  if (worse <= 60) return "9 (Mint)";
  if (worse <= 65) return "8.5 (NM-MT+)";
  if (worse <= 70) return "8 (NM-MT)";
  return "7.5 or lower";
};

export const calculateGrades = (p: CenteringPercentages): GradePredictions => ({
  psa: getPsaGrade(p.worstAxis),
  bgs: getBgsGrade(p.worstAxis),
  cgc: getCgcGrade(p.worstAxis),
  sgc: getSgcGrade(p.worstAxis),
  tag: getTagGrade(p.worstAxis),
});

// ─── Master Calculate ─────────────────────────────────────────────────────────

export interface FullCenteringCalculation {
  measurements: BorderMeasurements;
  percentages: CenteringPercentages;
  truepointScore: number;
  grades: GradePredictions;
}

export const calculateCentering = (
  borders: BorderPositions,
  imageWidth: number,
  imageHeight: number,
  dpi: number,
): FullCenteringCalculation => {
  const measurements = calculateMeasurements(
    borders,
    imageWidth,
    imageHeight,
    dpi,
  );
  const percentages = calculatePercentages(measurements);
  const truepointScore = calculateTruepointScore(percentages);
  const grades = calculateGrades(percentages);

  return { measurements, percentages, truepointScore, grades };
};

// ─── Validation ───────────────────────────────────────────────────────────────

export const validateBorders = (borders: BorderPositions): string | null => {
  const {
    outerLeft,
    outerRight,
    outerTop,
    outerBottom,
    innerLeft,
    innerRight,
    innerTop,
    innerBottom,
  } = borders;

  if (outerLeft >= innerLeft) return "outer_left must be less than inner_left";
  if (innerRight >= outerRight)
    return "inner_right must be less than outer_right";
  if (outerTop >= innerTop) return "outer_top must be less than inner_top";
  if (innerBottom >= outerBottom)
    return "inner_bottom must be less than outer_bottom";

  const values = [
    outerLeft,
    outerRight,
    outerTop,
    outerBottom,
    innerLeft,
    innerRight,
    innerTop,
    innerBottom,
  ];
  if (values.some((v) => v < 0 || v > 1))
    return "All border values must be between 0 and 1";

  return null;
};

// ─── Helper ───────────────────────────────────────────────────────────────────

const round = (value: number, decimals: number): number =>
  Math.round(value * 10 ** decimals) / 10 ** decimals;

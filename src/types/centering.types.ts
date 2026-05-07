export interface BorderPositions {
  // All values normalized 0–1 (frontend sends percentages, server converts)
  outerLeft: number;
  outerRight: number;
  outerTop: number;
  outerBottom: number;
  innerLeft: number;
  innerRight: number;
  innerTop: number;
  innerBottom: number;
}

export interface CenteringInput {
  borders: BorderPositions;
  imageWidth: number; // pixels
  imageHeight: number; // pixels
  dpi: number; // default 1600
  rotation: number; // degrees, stored for reference
  side: "front" | "back";
  cardId?: string; // pokemontcg.io card ID
  inventoryItemId?: string;
  /** Optional user-visible name for the report */
  label?: string | null;
}

export interface BorderMeasurements {
  leftMm: number;
  rightMm: number;
  topMm: number;
  bottomMm: number;
}

export interface CenteringPercentages {
  leftPct: number;
  rightPct: number;
  topPct: number;
  bottomPct: number;
  lrWorse: number; // max of left/right
  tbWorse: number; // max of top/bottom
  worstAxis: number; // max of lrWorse/tbWorse
}

export interface GradePredictions {
  psa: string;
  bgs: string;
  cgc: string;
  sgc: string;
  tag: string;
}

export interface CenteringReport {
  id: string;
  userId: string;
  cardId: string | null;
  inventoryItemId: string | null;
  side: "front" | "back";
  imageWidth: number;
  imageHeight: number;
  dpi: number;
  rotation: number;
  borders: BorderPositions;
  measurements: BorderMeasurements;
  percentages: CenteringPercentages;
  truepointScore: number;
  grades: GradePredictions;
  createdAt: string;
  label: string | null;
}

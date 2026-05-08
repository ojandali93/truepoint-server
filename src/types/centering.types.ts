export interface BorderPositions {
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
  cardId?: string | null;
  inventoryItemId?: string | null;
  side: "front" | "back";
  imageWidth: number;
  imageHeight: number;
  dpi: number;
  rotation: number;
  borders: BorderPositions;
  label?: string | null; // ← add
  imageUrl?: string | null; // ← add
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
  measurements: {
    leftMm: number;
    rightMm: number;
    topMm: number;
    bottomMm: number;
  };
  percentages: {
    leftPct: number;
    rightPct: number;
    topPct: number;
    bottomPct: number;
    lrWorse: number;
    tbWorse: number;
    worstAxis: number;
  };
  truepointScore: number;
  grades: {
    psa: string;
    bgs: string;
    cgc: string;
    sgc: string;
    tag: string;
  };
  label: string | null; // ← add
  imageUrl: string | null; // ← add
  createdAt: string;
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

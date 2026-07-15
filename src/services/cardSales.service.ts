// Recent TCGPlayer sales for a card, with outlier detection.
//
// cards.id IS the TCGPlayer product ID (string form), verified via the
// PokeTrace integration — so we hit TCGAPIs sales-history with it directly.
import { tcgapisGet } from "../lib/tcgapisClient";

export interface RecentSale {
  date: string;
  condition: string | null;
  variant: string | null;
  price: number;
  isOutlier: boolean;
}

export interface RecentSalesResult {
  productUrl: string;
  count: number;
  median: number | null;
  average: number | null; // excludes outliers
  sales: RecentSale[];
}

interface TcgapisSaleRow {
  date: string;
  marketplace?: string;
  condition?: string | null;
  price?: number | string | null;
  variant?: string | null;
}

interface TcgapisSalesResponse {
  success?: boolean;
  data?: {
    sales?: TcgapisSaleRow[];
  };
}

const median = (nums: number[]): number | null => {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Quartile via linear interpolation (same method spreadsheets use). */
const quantile = (sorted: number[], q: number): number => {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
};

/**
 * Flag outliers with the 1.5×IQR rule (robust to a few wild sales). A lone $200
 * among a cluster of $500s falls below Q1 − 1.5·IQR and gets tagged.
 */
const markOutliers = (prices: number[]): boolean[] => {
  if (prices.length < 4) return prices.map(() => false); // too few to judge
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = quantile(sorted, 0.25);
  const q3 = quantile(sorted, 0.75);
  const iqr = q3 - q1;
  const lo = q1 - 1.5 * iqr;
  const hi = q3 + 1.5 * iqr;
  return prices.map((p) => p < lo || p > hi);
};

export const getRecentSales = async (
  cardId: string,
  limit = 15,
): Promise<RecentSalesResult> => {
  const productUrl = `https://www.tcgplayer.com/product/${cardId}`;
  let raw: TcgapisSaleRow[] = [];
  try {
    const res = await tcgapisGet<TcgapisSalesResponse>(
      `/api/v1/sales-history/${cardId}`,
    );
    raw = res?.data?.sales ?? [];
  } catch {
    // No sales / not found / upstream hiccup → empty, not an error.
    raw = [];
  }

  // Newest first, coerce price, keep the most recent `limit`.
  const cleaned = raw
    .map((s) => ({
      date: s.date,
      condition: s.condition ?? null,
      variant: s.variant ?? null,
      price: typeof s.price === "string" ? parseFloat(s.price) : (s.price ?? 0),
    }))
    .filter((s) => Number.isFinite(s.price) && s.price > 0 && !!s.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, limit);

  const flags = markOutliers(cleaned.map((s) => s.price));
  const sales: RecentSale[] = cleaned.map((s, i) => ({
    ...s,
    isOutlier: flags[i],
  }));

  const nonOutlier = sales.filter((s) => !s.isOutlier).map((s) => s.price);
  const average =
    nonOutlier.length > 0
      ? Math.round(
          (nonOutlier.reduce((a, b) => a + b, 0) / nonOutlier.length) * 100,
        ) / 100
      : null;

  return {
    productUrl,
    count: sales.length,
    median: median(sales.map((s) => s.price)),
    average,
    sales,
  };
};

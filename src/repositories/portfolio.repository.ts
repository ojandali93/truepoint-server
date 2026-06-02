import { supabaseAdmin } from "../lib/supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PortfolioSnapshot {
  id: string;
  userId: string;
  snapshotDate: string;
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  rawCardValue: number;
  gradedCardValue: number;
  sealedProductValue: number;
  totalItems: number;
  rawCards: number;
  gradedCards: number;
  sealedProducts: number;
  createdAt: string;
}

export interface SnapshotInsert {
  userId: string;
  collectionId?: string | null;
  snapshotDate: string;
  totalValue: number;
  totalCostBasis: number;
  totalGainLoss: number;
  rawCardValue: number;
  gradedCardValue: number;
  sealedProductValue: number;
  totalItems: number;
  rawCards: number;
  gradedCards: number;
  sealedProducts: number;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const rowToSnapshot = (row: any): PortfolioSnapshot => ({
  id: row.id,
  userId: row.user_id,
  snapshotDate: row.snapshot_date,
  totalValue: Number(row.total_value),
  totalCostBasis: Number(row.total_cost_basis),
  totalGainLoss: Number(row.total_gain_loss),
  rawCardValue: Number(row.raw_card_value),
  gradedCardValue: Number(row.graded_card_value),
  sealedProductValue: Number(row.sealed_product_value),
  totalItems: row.total_items,
  rawCards: row.raw_cards,
  gradedCards: row.graded_cards,
  sealedProducts: row.sealed_products,
  createdAt: row.created_at,
});

// ─── Queries ──────────────────────────────────────────────────────────────────

// Get snapshots for a user within a date range.
//
// IMPORTANT: there is one aggregate row per day (collection_id IS NULL) and
// optionally one per-collection row per collection. The aggregate row already
// contains the sum across all collections.
//
//   - collectionId omitted / null  → return ONLY aggregate rows (1 row/day)
//   - collectionId specified       → return rows for that specific collection
//
// Previously this returned every row when no collectionId was given, which
// produced multiple points per day on the dashboard chart (one per collection
// + the aggregate), causing dramatic spikes between $0 and the real value.
export const findSnapshotsByUser = async (
  userId: string,
  days = 90,
  collectionId?: string | null,
): Promise<PortfolioSnapshot[]> => {
  const since = new Date();
  since.setDate(since.getDate() - days);

  let q = supabaseAdmin
    .from("portfolio_snapshots")
    .select("*")
    .eq("user_id", userId)
    .gte("snapshot_date", since.toISOString().split("T")[0])
    .order("snapshot_date", { ascending: true });

  if (collectionId) {
    q = q.eq("collection_id", collectionId);
  } else {
    // Aggregate view — only the cron-produced sum rows, never per-collection rows
    q = q.is("collection_id", null);
  }

  const { data, error } = await q;

  if (error) {
    console.error("[PortfolioRepo] findSnapshots error:", error);
    throw error;
  }
  return (data ?? []).map(rowToSnapshot);
};

// Get the most recent snapshot for a user.
//
// Same aggregate-vs-per-collection distinction as findSnapshotsByUser. When
// no collectionId is given, we return the latest AGGREGATE row, not the
// latest per-collection row that happens to sort highest.
export const findLatestSnapshot = async (
  userId: string,
  collectionId?: string | null,
): Promise<PortfolioSnapshot | null> => {
  let q = supabaseAdmin
    .from("portfolio_snapshots")
    .select("*")
    .eq("user_id", userId);

  if (collectionId) {
    q = q.eq("collection_id", collectionId);
  } else {
    q = q.is("collection_id", null);
  }

  const { data, error } = await q
    .order("snapshot_date", { ascending: false })
    .limit(1)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data ? rowToSnapshot(data) : null;
};

// Upsert a snapshot for today — safe to call multiple times
export const upsertSnapshot = async (
  input: SnapshotInsert,
): Promise<PortfolioSnapshot> => {
  const { data, error } = await supabaseAdmin
    .from("portfolio_snapshots")
    .upsert(
      {
        user_id: input.userId,
        collection_id: input.collectionId ?? null,
        snapshot_date: input.snapshotDate,
        total_value: input.totalValue,
        total_cost_basis: input.totalCostBasis,
        total_gain_loss: input.totalGainLoss,
        raw_card_value: input.rawCardValue,
        graded_card_value: input.gradedCardValue,
        sealed_product_value: input.sealedProductValue,
        total_items: input.totalItems,
        raw_cards: input.rawCards,
        graded_cards: input.gradedCards,
        sealed_products: input.sealedProducts,
      },
      {
        onConflict: "user_id,collection_id,snapshot_date",
        ignoreDuplicates: false,
      },
    )
    .select()
    .single();

  if (error) {
    console.error("[PortfolioRepo] upsertSnapshot error:", error);
    throw error;
  }
  return rowToSnapshot(data);
};

// Get all distinct user IDs that have inventory — for the cron job
export const findAllUsersWithInventory = async (): Promise<string[]> => {
  const { data, error } = await supabaseAdmin
    .from("inventory")
    .select("user_id")
    .not("user_id", "is", null);

  if (error) {
    console.error("[PortfolioRepo] findAllUsers error:", error);
    throw error;
  }

  const unique = [...new Set((data ?? []).map((r: any) => r.user_id))];
  return unique;
};

import { supabaseAdmin } from "../lib/supabase";

// A point-in-time snapshot of one card on a side of a trade. Stored as jsonb so
// the trade record stays readable even after the underlying inventory item or
// catalog card changes. Mirrors the mobile TradeCard shape.
export interface TradeCardSnapshot {
  id: string;
  name: string;
  setName: string;
  number: string;
  imageSmall: string | null;
  value: number;
  gradingCompany: string | null;
  grade: string | null;
  // Identity used when the trade mutates inventory:
  inventoryId?: string | null; // give-side: the existing inventory row
  cardId?: string | null; // get-side: catalog card reference
  productId?: string | null; // get-side: sealed product reference
  itemType?: string | null;
  variantType?: string | null;
  condition?: string | null;
}

export interface TradeRow {
  id: string;
  user_id: string;
  give_cards: TradeCardSnapshot[];
  get_cards: TradeCardSnapshot[];
  give_cash: number;
  get_cash: number;
  give_total: number; // cards + cash
  get_total: number;
  net: number; // get_total - give_total (your gain)
  notes: string | null;
  traded_at: string;
  traded_inventory_ids: string[]; // give-side rows we set to 'traded'
  created_inventory_ids: string[]; // get-side rows we inserted
  created_at: string;
}

export interface InsertTradeInput {
  give_cards: TradeCardSnapshot[];
  get_cards: TradeCardSnapshot[];
  give_cash: number;
  get_cash: number;
  give_total: number;
  get_total: number;
  net: number;
  notes: string | null;
  traded_at: string;
  traded_inventory_ids: string[];
  created_inventory_ids: string[];
}

export const insertTrade = async (
  userId: string,
  input: InsertTradeInput,
): Promise<TradeRow> => {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .insert({ user_id: userId, ...input })
    .select("*")
    .single();

  if (error) {
    console.error("[TradesRepo] insert error:", error);
    throw error;
  }
  return data as TradeRow;
};

export const findTradesByUser = async (userId: string): Promise<TradeRow[]> => {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("*")
    .eq("user_id", userId)
    .order("traded_at", { ascending: false });

  if (error) {
    console.error("[TradesRepo] findByUser error:", error);
    throw error;
  }
  return (data ?? []) as TradeRow[];
};

export const findTradeById = async (id: string): Promise<TradeRow | null> => {
  const { data, error } = await supabaseAdmin
    .from("trades")
    .select("*")
    .eq("id", id)
    .single();

  if (error && error.code !== "PGRST116") throw error;
  return data as TradeRow | null;
};

export const deleteTrade = async (
  id: string,
  userId: string,
): Promise<void> => {
  const { error } = await supabaseAdmin
    .from("trades")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) {
    console.error("[TradesRepo] delete error:", error);
    throw error;
  }
};

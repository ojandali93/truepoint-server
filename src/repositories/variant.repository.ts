// src/repositories/variant.repository.ts
import { supabaseAdmin } from "../lib/supabase";

export interface VariantDef {
  type: string;
  label: string;
  color: string;
  sort_order: number;
}

export interface CardVariant {
  id: string;
  cardId: string;
  setId: string;
  variantType: string;
  label: string;
  color: string;
  sortOrder: number;
  notes: string | null;
}

export interface SetVariantRule {
  id: string;
  setId: string;
  rarity: string;
  variants: VariantDef[];
}

export type VariantStatus = "pending" | "ready";

// ─── Status ───────────────────────────────────────────────────────────────────

export const getSetVariantStatus = async (
  setId: string,
): Promise<VariantStatus> => {
  const { data } = await supabaseAdmin
    .from("set_variant_status")
    .select("status")
    .eq("set_id", setId)
    .single();
  return (data?.status as VariantStatus) ?? "pending";
};

export const getMultipleSetStatuses = async (
  setIds: string[],
): Promise<Map<string, VariantStatus>> => {
  if (!setIds.length) return new Map();
  const { data } = await supabaseAdmin
    .from("set_variant_status")
    .select("set_id, status")
    .in("set_id", setIds);
  const map = new Map<string, VariantStatus>();
  for (const row of data ?? []) {
    map.set(row.set_id, row.status as VariantStatus);
  }
  return map;
};

export const setVariantReady = async (
  setId: string,
  variantCount: number,
): Promise<void> => {
  await supabaseAdmin.from("set_variant_status").upsert(
    {
      set_id: setId,
      status: "ready",
      variant_count: variantCount,
      last_updated: new Date().toISOString(),
    },
    { onConflict: "set_id" },
  );
};

// ─── Rules (set-level defaults) ───────────────────────────────────────────────

export const getSetVariantRules = async (
  setId: string,
): Promise<SetVariantRule[]> => {
  const { data, error } = await supabaseAdmin
    .from("set_variant_rules")
    .select("*")
    .eq("set_id", setId)
    .order("rarity");
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id,
    setId: r.set_id,
    rarity: r.rarity,
    variants: r.variants as VariantDef[],
  }));
};

export const upsertSetVariantRules = async (
  setId: string,
  rules: { rarity: string; variants: VariantDef[] }[],
): Promise<void> => {
  const rows = rules.map((r) => ({
    set_id: setId,
    rarity: r.rarity,
    variants: r.variants,
    updated_at: new Date().toISOString(),
  }));
  const { error } = await supabaseAdmin
    .from("set_variant_rules")
    .upsert(rows, { onConflict: "set_id,rarity" });
  if (error) throw error;
};

// ─── Card-level variants ──────────────────────────────────────────────────────

export const getCardVariants = async (
  cardId: string,
): Promise<CardVariant[]> => {
  const { data, error } = await supabaseAdmin
    .from("card_variants")
    .select("*")
    .eq("card_id", cardId)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []).map(rowToVariant);
};

export const getSetCardVariants = async (
  setId: string,
): Promise<Map<string, CardVariant[]>> => {
  const { data, error } = await supabaseAdmin
    .from("card_variants")
    .select("*")
    .eq("set_id", setId)
    .order("sort_order");
  if (error) throw error;

  const map = new Map<string, CardVariant[]>();
  for (const row of data ?? []) {
    const cardId = row.card_id;
    if (!map.has(cardId)) map.set(cardId, []);
    map.get(cardId)!.push(rowToVariant(row));
  }
  return map;
};

export const upsertCardVariants = async (
  cardId: string,
  setId: string,
  variants: {
    variantType: string;
    label: string;
    color: string;
    sortOrder: number;
    notes?: string;
  }[],
): Promise<void> => {
  // Delete existing variants for this card then reinsert
  await supabaseAdmin.from("card_variants").delete().eq("card_id", cardId);

  if (!variants.length) return;

  const rows = variants.map((v) => ({
    card_id: cardId,
    set_id: setId,
    variant_type: v.variantType,
    label: v.label,
    color: v.color,
    sort_order: v.sortOrder,
    notes: v.notes ?? null,
  }));

  const { error } = await supabaseAdmin.from("card_variants").insert(rows);
  if (error) throw error;
};

export const bulkUpsertCardVariants = async (
  rows: {
    cardId: string;
    setId: string;
    variantType: string;
    label: string;
    color: string;
    sortOrder: number;
  }[],
): Promise<void> => {
  if (!rows.length) return;
  const { error } = await supabaseAdmin.from("card_variants").upsert(
    rows.map((r) => ({
      card_id: r.cardId,
      set_id: r.setId,
      variant_type: r.variantType,
      label: r.label,
      color: r.color,
      sort_order: r.sortOrder,
    })),
    { onConflict: "card_id,variant_type" },
  );
  if (error) throw error;
};

const rowToVariant = (row: any): CardVariant => ({
  id: row.id,
  cardId: row.card_id,
  setId: row.set_id,
  variantType: row.variant_type,
  label: row.label,
  color: row.color,
  sortOrder: row.sort_order,
  notes: row.notes,
});

// src/services/variant.service.ts
import { supabaseAdmin } from "../lib/supabase";
import {
  getSetVariantStatus,
  getSetVariantRules,
  getSetCardVariants,
  upsertSetVariantRules,
  bulkUpsertCardVariants,
  setVariantReady,
  VariantDef,
} from "../repositories/variant.repository";

export { getSetVariantStatus, getSetVariantRules, getSetCardVariants };

// ─── Get all variant data for a set (used by card browser) ───────────────────

export const getSetVariantData = async (setId: string) => {
  const status = await getSetVariantStatus(setId);
  if (status === "pending") {
    return { status: "pending", rules: [], cardVariants: new Map() };
  }

  const [rules, cardVariants] = await Promise.all([
    getSetVariantRules(setId),
    getSetCardVariants(setId),
  ]);

  return { status: "ready", rules, cardVariants };
};

// ─── Resolve variants for a specific card ────────────────────────────────────
// Uses card-level overrides if they exist, falls back to set rules by rarity

export const resolveCardVariants = async (
  cardId: string,
  rarity: string,
  setId: string,
): Promise<VariantDef[]> => {
  // Check card-level override first
  const { data: cardOverrides } = await supabaseAdmin
    .from("card_variants")
    .select("*")
    .eq("card_id", cardId)
    .order("sort_order");

  if (cardOverrides && cardOverrides.length > 0) {
    return cardOverrides.map((r: any) => ({
      type: r.variant_type,
      label: r.label,
      color: r.color,
      sort_order: r.sort_order,
    }));
  }

  // Fall back to set rule for this rarity
  const { data: rule } = await supabaseAdmin
    .from("set_variant_rules")
    .select("variants")
    .eq("set_id", setId)
    .eq("rarity", rarity)
    .single();

  if (rule?.variants) {
    return rule.variants as VariantDef[];
  }

  // Default — Normal only
  return [{ type: "normal", label: "Normal", color: "#6B7280", sort_order: 0 }];
};

// ─── Admin: save full variant config for a set ────────────────────────────────
// Saves rules + card overrides + marks set as ready

export interface AdminVariantSave {
  setId: string;
  rules: { rarity: string; variants: VariantDef[] }[];
  cardOverrides: {
    cardId: string;
    variants: {
      variantType: string;
      label: string;
      color: string;
      sortOrder: number;
      notes?: string;
    }[];
  }[];
}

export const saveSetVariants = async (
  input: AdminVariantSave,
): Promise<{ saved: number }> => {
  const { setId, rules, cardOverrides } = input;

  // 1. Save set-level rules
  if (rules.length > 0) {
    await upsertSetVariantRules(setId, rules);
  }

  // 2. Generate card variants for ALL cards in the set using the rules
  const { data: cards } = await supabaseAdmin
    .from("cards")
    .select("id, rarity")
    .eq("set_id", setId);

  if (!cards?.length)
    throw { status: 404, message: "No cards found for this set" };

  // Build override map
  const overrideMap = new Map(cardOverrides.map((o) => [o.cardId, o.variants]));

  // Build rule map by rarity
  const ruleMap = new Map(rules.map((r) => [r.rarity, r.variants]));

  // Generate variant rows for each card
  const variantRows: {
    cardId: string;
    setId: string;
    variantType: string;
    label: string;
    color: string;
    sortOrder: number;
  }[] = [];

  for (const card of cards) {
    const variants = overrideMap.get(card.id) ??
      ruleMap.get(card.rarity ?? "") ?? [
        {
          variantType: "normal",
          label: "Normal",
          color: "#6B7280",
          sortOrder: 0,
        },
      ];

    for (const v of variants) {
      variantRows.push({
        cardId: card.id,
        setId,
        variantType: (v as any).variantType ?? (v as any).type,
        label: v.label,
        color: v.color,
        sortOrder: (v as any).sortOrder ?? (v as any).sort_order ?? 0,
      });
    }
  }

  // 3. Bulk insert all variant rows
  // Delete existing first for clean slate
  await supabaseAdmin.from("card_variants").delete().eq("set_id", setId);
  await bulkUpsertCardVariants(variantRows);

  // 4. Mark set as ready
  await setVariantReady(setId, variantRows.length);

  console.log(
    `[VariantService] Saved ${variantRows.length} variants for set ${setId}`,
  );
  return { saved: variantRows.length };
};

// ─── Get variant-enriched cards for a set ─────────────────────────────────────

export const getCardsWithVariants = async (setId: string) => {
  const [cards, cardVariantMap] = await Promise.all([
    supabaseAdmin
      .from("cards")
      .select("*, sets(id, name)")
      .eq("set_id", setId)
      .order("number"),
    getSetCardVariants(setId),
  ]);

  if (cards.error) throw cards.error;

  return (cards.data ?? []).map((card: any) => ({
    id: card.id,
    name: card.name,
    number: card.number,
    supertype: card.supertype,
    subtypes: card.subtypes,
    hp: card.hp,
    types: card.types,
    rarity: card.rarity,
    set: { id: card.set_id, name: card.sets?.name ?? card.set_id },
    images: { small: card.image_small, large: card.image_large },
    variants: cardVariantMap.get(card.id) ?? [],
  }));
};

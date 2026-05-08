// src/services/variantSync.service.ts
import { supabaseAdmin } from "../lib/supabase";
import { tcgdexClient, TCGdexVariants } from "../lib/tcgdexClient";
import {
  setVariantReady,
  upsertSetVariantRules,
} from "../repositories/variant.repository";

// ─── Variant color palette ─────────────────────────────────────────────────

const VARIANT_COLORS = {
  normal: "#6B7280",
  reverse_holo: "#A78BFA",
  holo: "#F59E0B",
  first_edition: "#10B981",
  pokeball_holo: "#EF4444",
  masterball_holo: "#8B5CF6",
  greatball_holo: "#3B82F6",
  ultraball_holo: "#F97316",
  energy_holo: "#06B6D4",
  cosmos_holo: "#EC4899",
  galaxy_holo: "#6366F1",
  starlight_holo: "#FBBF24",
  cracked_ice_holo: "#67E8F9",
  mirror_holo: "#C0C0C0",
  loveball_holo: "#FB7185",
  friendball_holo: "#4ADE80",
  quickball_holo: "#FDE68A",
  duskball_holo: "#7C3AED",
};

const VARIANT_LABELS: Record<string, string> = {
  normal: "Normal",
  reverse_holo: "Reverse Holo",
  holo: "Holofoil",
  first_edition: "1st Edition",
  pokeball_holo: "Poké Ball Holo",
  masterball_holo: "Master Ball Holo",
  greatball_holo: "Great Ball Holo",
  ultraball_holo: "Ultra Ball Holo",
  energy_holo: "Energy Holo",
  cosmos_holo: "Cosmos Holo",
  galaxy_holo: "Galaxy Holo",
  starlight_holo: "Starlight Holo",
  cracked_ice_holo: "Cracked Ice Holo",
  mirror_holo: "Mirror Holo",
  loveball_holo: "Love Ball Holo",
  friendball_holo: "Friend Ball Holo",
  quickball_holo: "Quick Ball Holo",
  duskball_holo: "Dusk Ball Holo",
};

// Map TCGdex foil string → our variant type key
const FOIL_TO_VARIANT: Record<string, string> = {
  pokeball: "pokeball_holo",
  masterball: "masterball_holo",
  greatball: "greatball_holo",
  ultraball: "ultraball_holo",
  energy: "energy_holo",
  cosmos: "cosmos_holo",
  galaxy: "galaxy_holo",
  starlight: "starlight_holo",
  "cracked-ice": "cracked_ice_holo",
  mirror: "mirror_holo",
  loveball: "loveball_holo",
  friendball: "friendball_holo",
  quickball: "quickball_holo",
  duskball: "duskball_holo",
  "team-rocket": "reverse_holo", // team rocket R pattern is a reverse holo
};

// ─── Convert TCGdex variants to our format ─────────────────────────────────

interface VariantRow {
  cardId: string;
  setId: string;
  variantType: string;
  label: string;
  color: string;
  sortOrder: number;
}

const buildVariantRows = (
  cardId: string,
  setId: string,
  tcgVariants: TCGdexVariants,
  foil?: string,
): VariantRow[] => {
  const rows: VariantRow[] = [];
  let order = 0;

  const add = (type: string) => {
    const color =
      VARIANT_COLORS[type as keyof typeof VARIANT_COLORS] ?? "#6B7280";
    const label = VARIANT_LABELS[type] ?? type;
    rows.push({
      cardId,
      setId,
      variantType: type,
      label,
      color,
      sortOrder: order++,
    });
  };

  // Standard variants from TCGdex boolean flags
  if (tcgVariants.normal) add("normal");
  if (tcgVariants.firstEdition) add("first_edition");
  if (tcgVariants.holo) add("holo");
  if (tcgVariants.reverse) {
    // If there's a specific foil pattern for the reverse, add that instead
    if (foil && FOIL_TO_VARIANT[foil]) {
      add(FOIL_TO_VARIANT[foil]);
    } else {
      add("reverse_holo");
    }
  }

  // Some SV-era sets have BOTH pokeball and masterball reverses
  // TCGdex may only report one foil type per card — we detect this
  // by checking if the set has the pokeball/masterball dual-pattern
  // This is handled at the set level via set rules (see seedSetRules)

  return rows;
};

// ─── Sync a single set ─────────────────────────────────────────────────────

export interface SetSyncResult {
  setId: string;
  setName: string;
  status: "synced" | "partial" | "not_found" | "error";
  cardsProcessed: number;
  variantsSaved: number;
  missingFoilData: boolean;
  notes: string[];
}

export const syncVariantsForSet = async (
  setId: string,
  setName: string,
): Promise<SetSyncResult> => {
  const result: SetSyncResult = {
    setId,
    setName,
    status: "not_found",
    cardsProcessed: 0,
    variantsSaved: 0,
    missingFoilData: false,
    notes: [],
  };

  console.log(`[VariantSync] Fetching TCGdex data for: ${setName} (${setId})`);

  // Fetch cards from TCGdex
  const tcgCards = await tcgdexClient.getSetCards(setId);

  if (!tcgCards.length) {
    result.notes.push(
      `TCGdex returned no cards — set ID may differ or set not yet in TCGdex`,
    );
    console.warn(
      `[VariantSync] No TCGdex data for ${setId} — manual entry needed`,
    );

    // Still mark as pending so admin knows to fill in
    await supabaseAdmin.from("set_variant_status").upsert(
      {
        set_id: setId,
        status: "pending",
        variant_count: 0,
        last_updated: new Date().toISOString(),
      },
      { onConflict: "set_id" },
    );
    return result;
  }

  // Build a map of TCGdex card data keyed by card ID
  const tcgMap = new Map(tcgCards.map((c) => [c.id, c]));

  // Get our cards for this set from the DB
  const { data: dbCards, error } = await supabaseAdmin
    .from("cards")
    .select("id, rarity")
    .eq("set_id", setId);

  if (error || !dbCards?.length) {
    result.status = "error";
    result.notes.push("Could not fetch cards from database");
    return result;
  }

  // Detect if this is an SV-era set with dual ball patterns
  // (Pokéball AND Master Ball reverses for the same card)
  const isDualBallSet = isDualBallEraSet(setId);
  const foilPatterns = getDualBallPatterns(setId);

  // Build variant rows
  const allVariantRows: VariantRow[] = [];
  const cardsWithFoilData: string[] = [];
  const cardsWithoutFoilData: string[] = [];

  for (const dbCard of dbCards) {
    const tcgCard = tcgMap.get(dbCard.id);
    result.cardsProcessed++;

    if (!tcgCard) {
      // Card not in TCGdex — use rarity-based rules as fallback
      const fallbackRows = buildFallbackVariants(
        dbCard.id,
        setId,
        dbCard.rarity ?? "",
        isDualBallSet,
        foilPatterns,
      );
      allVariantRows.push(...fallbackRows);
      continue;
    }

    // Get variant rows from TCGdex data
    const variantRows = buildVariantRows(
      dbCard.id,
      setId,
      tcgCard.variants,
      tcgCard.foil,
    );

    // For dual-ball sets: TCGdex may only track one ball pattern
    // We need to add both pokeball AND masterball for C/U cards
    if (isDualBallSet && tcgCard.variants.reverse) {
      const expandedRows = expandDualBallVariants(
        dbCard.id,
        setId,
        variantRows,
        dbCard.rarity ?? "",
        foilPatterns,
      );
      allVariantRows.push(...expandedRows);
      if (tcgCard.foil) cardsWithFoilData.push(dbCard.id);
    } else {
      allVariantRows.push(...variantRows);
      if (tcgCard.foil) cardsWithFoilData.push(dbCard.id);
      else if (tcgCard.variants.reverse) cardsWithoutFoilData.push(dbCard.id);
    }
  }

  // Check if foil data is incomplete
  if (cardsWithoutFoilData.length > 0 && !isDualBallSet) {
    result.missingFoilData = true;
    result.notes.push(
      `${cardsWithoutFoilData.length} cards have reverse holos but no foil pattern specified`,
    );
  }

  // Delete existing variants for this set and reinsert
  await supabaseAdmin.from("card_variants").delete().eq("set_id", setId);

  // Batch insert in chunks of 500
  const CHUNK = 500;
  for (let i = 0; i < allVariantRows.length; i += CHUNK) {
    const chunk = allVariantRows.slice(i, i + CHUNK);
    const { error: insertErr } = await supabaseAdmin
      .from("card_variants")
      .insert(
        chunk.map((r) => ({
          card_id: r.cardId,
          set_id: r.setId,
          variant_type: r.variantType,
          label: r.label,
          color: r.color,
          sort_order: r.sortOrder,
        })),
      );
    if (insertErr) {
      console.error(
        `[VariantSync] Insert error for ${setId}:`,
        insertErr.message,
      );
      result.status = "error";
      return result;
    }
  }

  result.variantsSaved = allVariantRows.length;

  // Seed set-level rules
  await seedSetRules(setId);

  // Mark set as ready
  await setVariantReady(setId, allVariantRows.length);

  result.status = result.missingFoilData ? "partial" : "synced";

  console.log(
    `[VariantSync] ✓ ${setName}: ${result.cardsProcessed} cards → ${result.variantsSaved} variants` +
      (result.missingFoilData ? " (partial foil data)" : ""),
  );

  return result;
};

// ─── Detect SV dual-ball sets ────────────────────────────────────────────────

// Sets where common/uncommon cards have BOTH pokeball AND masterball reverses
// Started with sv8pt5 (Prismatic Evolutions) then continued
const DUAL_BALL_SETS = new Set([
  "sv8pt5", // Prismatic Evolutions
  "sv9", // Destined Rivals (based on screenshots showing pokeball/masterball)
  "sv9pt5", // Ascended Heroes (confirmed - loveball/friendball/quickball/duskball per card)
]);

// Sets with single special ball reverse (pokeball only, not masterball)
const POKEBALL_ONLY_SETS = new Set([
  "sv3pt5", // 151 — has Master Ball pattern
  "sv4pt5", // Paldean Fates — has special reverse patterns
]);

const isDualBallEraSet = (setId: string): boolean => {
  return DUAL_BALL_SETS.has(setId) || POKEBALL_ONLY_SETS.has(setId);
};

// Get the specific foil patterns for a set
const getDualBallPatterns = (setId: string): string[] => {
  if (DUAL_BALL_SETS.has(setId)) {
    return ["reverse_holo", "pokeball_holo", "masterball_holo"];
  }
  if (POKEBALL_ONLY_SETS.has(setId)) {
    return ["reverse_holo", "pokeball_holo"];
  }
  // Default SV era (sv1-sv8): normal reverse holo
  if (setId.startsWith("sv")) {
    return ["reverse_holo"];
  }
  // SWSH era: normal reverse holo
  return ["reverse_holo"];
};

// Expand single reverse holo into dual ball variants for applicable cards
const expandDualBallVariants = (
  cardId: string,
  setId: string,
  existingRows: VariantRow[],
  rarity: string,
  foilPatterns: string[],
): VariantRow[] => {
  // Only C/U cards get dual ball treatment
  const isCommonUncommon = rarity === "Common" || rarity === "Uncommon";

  if (!isCommonUncommon || foilPatterns.length <= 1) {
    return existingRows;
  }

  // Remove the existing reverse_holo entry and replace with all ball patterns
  const withoutReverse = existingRows.filter(
    (r) =>
      r.variantType !== "reverse_holo" &&
      r.variantType !== "pokeball_holo" &&
      r.variantType !== "masterball_holo",
  );

  const ballRows: VariantRow[] = foilPatterns.map((pattern, i) => ({
    cardId,
    setId,
    variantType: pattern,
    label: VARIANT_LABELS[pattern] ?? pattern,
    color: VARIANT_COLORS[pattern as keyof typeof VARIANT_COLORS] ?? "#6B7280",
    sortOrder: withoutReverse.length + i,
  }));

  return [...withoutReverse, ...ballRows];
};

// Fallback variants when card not in TCGdex — use rarity rules
const buildFallbackVariants = (
  cardId: string,
  setId: string,
  rarity: string,
  isDualBall: boolean,
  foilPatterns: string[],
): VariantRow[] => {
  const rows: VariantRow[] = [];
  let order = 0;
  const add = (type: string) => {
    rows.push({
      cardId,
      setId,
      variantType: type,
      label: VARIANT_LABELS[type] ?? type,
      color: VARIANT_COLORS[type as keyof typeof VARIANT_COLORS] ?? "#6B7280",
      sortOrder: order++,
    });
  };

  const isCommonUncommon = rarity === "Common" || rarity === "Uncommon";
  const isRare = rarity === "Rare";
  const isHigherRarity = !isCommonUncommon && !isRare;

  add("normal");

  if (!isHigherRarity) {
    if (isDualBall && isCommonUncommon) {
      foilPatterns.forEach(add);
    } else if (setId.startsWith("sv") || setId.startsWith("swsh")) {
      add("reverse_holo");
    }
  }

  if (
    rarity === "Rare Holo" ||
    (rarity === "Rare" &&
      (setId.startsWith("swsh") ||
        setId.startsWith("xy") ||
        setId.startsWith("xy")))
  ) {
    add("holo");
  }

  return rows;
};

// ─── Seed set-level rules ────────────────────────────────────────────────────

const seedSetRules = async (setId: string): Promise<void> => {
  const foilPatterns = getDualBallPatterns(setId);

  const cuVariants = [
    { type: "normal", label: "Normal", color: "#6B7280", sort_order: 0 },
    ...foilPatterns.map((p, i) => ({
      type: p,
      label: VARIANT_LABELS[p],
      color: VARIANT_COLORS[p as keyof typeof VARIANT_COLORS] ?? "#6B7280",
      sort_order: i + 1,
    })),
  ];

  const rareVariants = [
    { type: "normal", label: "Normal", color: "#6B7280", sort_order: 0 },
    {
      type: "reverse_holo",
      label: "Reverse Holo",
      color: "#A78BFA",
      sort_order: 1,
    },
  ];

  const normalOnly = [
    { type: "normal", label: "Normal", color: "#6B7280", sort_order: 0 },
  ];

  const isSvEra = setId.startsWith("sv");
  const isSwshEra = setId.startsWith("swsh");

  const rules: { rarity: string; variants: any[] }[] = [
    { rarity: "Common", variants: cuVariants },
    { rarity: "Uncommon", variants: cuVariants },
    {
      rarity: "Rare",
      variants: isSvEra
        ? rareVariants
        : [
            ...rareVariants,
            {
              type: "holo",
              label: "Holofoil",
              color: "#F59E0B",
              sort_order: 2,
            },
          ],
    },
    {
      rarity: "Rare Holo",
      variants: [
        { type: "normal", label: "Normal", color: "#6B7280", sort_order: 0 },
        { type: "holo", label: "Holofoil", color: "#F59E0B", sort_order: 1 },
        {
          type: "reverse_holo",
          label: "Reverse Holo",
          color: "#A78BFA",
          sort_order: 2,
        },
      ],
    },
    { rarity: "Double Rare", variants: normalOnly },
    { rarity: "Ultra Rare", variants: normalOnly },
    { rarity: "Illustration Rare", variants: normalOnly },
    { rarity: "Special Illustration Rare", variants: normalOnly },
    { rarity: "Hyper Rare", variants: normalOnly },
    { rarity: "Promo", variants: normalOnly },
  ];

  if (isSwshEra) {
    rules.push(
      { rarity: "Rare Holo V", variants: normalOnly },
      { rarity: "Rare Holo VMAX", variants: normalOnly },
      { rarity: "Rare Holo VSTAR", variants: normalOnly },
      { rarity: "Rare Rainbow", variants: normalOnly },
      { rarity: "Rare Ultra", variants: normalOnly },
    );
  }

  await upsertSetVariantRules(setId, rules);
};

// ─── Sync all sets ────────────────────────────────────────────────────────────

export interface AllSyncResult {
  total: number;
  synced: number;
  partial: number;
  notFound: number;
  errors: number;
  needsAttention: SetSyncResult[];
}

export const syncAllVariants = async (): Promise<AllSyncResult> => {
  console.log("[VariantSync] Starting full variant sync...");

  const { data: sets, error } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .order("release_date", { ascending: false });

  if (error || !sets?.length) {
    console.error("[VariantSync] Could not fetch sets:", error);
    return {
      total: 0,
      synced: 0,
      partial: 0,
      notFound: 0,
      errors: 0,
      needsAttention: [],
    };
  }

  const results: SetSyncResult[] = [];
  const summary: AllSyncResult = {
    total: sets.length,
    synced: 0,
    partial: 0,
    notFound: 0,
    errors: 0,
    needsAttention: [],
  };

  for (const set of sets) {
    const result = await syncVariantsForSet(set.id, set.name);
    results.push(result);

    if (result.status === "synced") summary.synced++;
    else if (result.status === "partial") {
      summary.partial++;
      summary.needsAttention.push(result);
    } else if (result.status === "not_found") {
      summary.notFound++;
      summary.needsAttention.push(result);
    } else {
      summary.errors++;
      summary.needsAttention.push(result);
    }

    // Polite delay between sets
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`[VariantSync] Complete:`, summary);

  if (summary.needsAttention.length > 0) {
    console.warn("\n⚠️  SETS NEEDING ADMIN ATTENTION:");
    for (const s of summary.needsAttention) {
      console.warn(`  • ${s.setName} (${s.setId}): ${s.status}`);
      for (const note of s.notes) console.warn(`    → ${note}`);
    }
  }

  return summary;
};

// ─── Check for new sets without variants ─────────────────────────────────────
// Called on server startup — logs any sets that have cards but no variant data

export const checkForNewSetsWithoutVariants = async (): Promise<string[]> => {
  const { data: setsWithoutVariants } = await supabaseAdmin
    .from("sets")
    .select("id, name")
    .not(
      "id",
      "in",
      `(select set_id from set_variant_status where status = 'ready')`,
    );

  if (!setsWithoutVariants?.length) return [];

  // Filter to only sets that actually have cards (ignore empty sets)
  const setsWithCards: string[] = [];
  for (const set of setsWithoutVariants) {
    const { count } = await supabaseAdmin
      .from("cards")
      .select("id", { count: "exact", head: true })
      .eq("set_id", set.id);

    if ((count ?? 0) > 0) {
      setsWithCards.push(set.name);
      console.warn(
        `[VariantSync] ⚠️  NEW SET WITHOUT VARIANTS: ${set.name} (${set.id}) — admin action needed`,
      );
    }
  }

  return setsWithCards;
};

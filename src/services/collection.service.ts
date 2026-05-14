// src/services/collection.service.ts

import { supabaseAdmin } from "../lib/supabase";
import { getStaticLimit } from "./plan.service";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface Collection {
  id: string;
  user_id: string;
  name: string;
  description: string | null;
  color: string;
  icon: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface CollectionSummary extends Collection {
  itemCount: number;
  totalValue: number;
  costBasis: number;
}

export interface CreateCollectionInput {
  name: string;
  description?: string;
  color?: string;
  icon?: string;
}

// ─── Plan limit enforcement ───────────────────────────────────────────────────

const checkCollectionLimit = async (
  userId: string,
  role: string | null = null,
): Promise<void> => {
  const [limit, { count }] = await Promise.all([
    getStaticLimit(userId, "collections", role),
    supabaseAdmin
      .from("collections")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId),
  ]);

  const current = count ?? 0;
  const effectiveLimit = limit ?? Infinity;

  if (current >= effectiveLimit) {
    throw Object.assign(
      new Error(
        `Your plan allows ${limit} collection${limit === 1 ? "" : "s"}. Upgrade to Pro to add more.`,
      ),
      { status: 403, code: "COLLECTION_LIMIT_REACHED" },
    );
  }
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export const getCollections = async (userId: string): Promise<Collection[]> => {
  const { data, error } = await supabaseAdmin
    .from("collections")
    .select("*")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
};

export const getCollectionById = async (
  id: string,
  userId: string,
): Promise<Collection> => {
  const { data, error } = await supabaseAdmin
    .from("collections")
    .select("*")
    .eq("id", id)
    .eq("user_id", userId)
    .single();

  if (error)
    throw Object.assign(new Error("Collection not found"), { status: 404 });
  return data;
};

export const createCollection = async (
  userId: string,
  input: CreateCollectionInput,
  role: string | null = null,
): Promise<Collection> => {
  // Enforce plan limits
  await checkCollectionLimit(userId, role);

  const { data, error } = await supabaseAdmin
    .from("collections")
    .insert({
      user_id: userId,
      name: input.name.trim(),
      description: input.description?.trim() ?? null,
      color: input.color ?? "#C9A84C",
      icon: input.icon ?? "cards",
      is_default: false,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const updateCollection = async (
  id: string,
  userId: string,
  input: Partial<CreateCollectionInput>,
): Promise<Collection> => {
  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (input.name !== undefined) updates.name = input.name.trim();
  if (input.description !== undefined)
    updates.description = input.description.trim();
  if (input.color !== undefined) updates.color = input.color;
  if (input.icon !== undefined) updates.icon = input.icon;

  const { data, error } = await supabaseAdmin
    .from("collections")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();

  if (error) throw error;
  return data;
};

export const deleteCollection = async (
  id: string,
  userId: string,
  strategy: "reassign" | "delete" = "reassign",
): Promise<void> => {
  // Cannot delete the default collection
  const collection = await getCollectionById(id, userId);
  if (collection.is_default) {
    throw Object.assign(
      new Error(
        "Cannot delete your default collection. Set another as default first.",
      ),
      { status: 400 },
    );
  }

  if (strategy === "reassign") {
    // Move inventory to the default collection
    const { data: defaultCol } = await supabaseAdmin
      .from("collections")
      .select("id")
      .eq("user_id", userId)
      .eq("is_default", true)
      .single();

    if (defaultCol) {
      await supabaseAdmin
        .from("inventory")
        .update({ collection_id: defaultCol.id })
        .eq("collection_id", id);

      await supabaseAdmin
        .from("portfolio_snapshots")
        .update({ collection_id: defaultCol.id })
        .eq("collection_id", id);
    }
  }

  const { error } = await supabaseAdmin
    .from("collections")
    .delete()
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw error;
};

export const setDefaultCollection = async (
  id: string,
  userId: string,
): Promise<void> => {
  // Remove current default
  await supabaseAdmin
    .from("collections")
    .update({ is_default: false })
    .eq("user_id", userId)
    .eq("is_default", true);

  // Set new default
  const { error } = await supabaseAdmin
    .from("collections")
    .update({ is_default: true, updated_at: new Date().toISOString() })
    .eq("id", id)
    .eq("user_id", userId);

  if (error) throw error;
};

// ─── Summary (item count + portfolio value per collection) ────────────────────

export const getCollectionSummaries = async (
  userId: string,
): Promise<CollectionSummary[]> => {
  const collections = await getCollections(userId);
  if (!collections.length) return [];

  // Get item counts per collection
  const countResults = await Promise.all(
    collections.map((c) =>
      supabaseAdmin
        .from("inventory")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("collection_id", c.id),
    ),
  );

  // Get latest portfolio snapshot value per collection
  const snapshotResults = await Promise.all(
    collections.map((c) =>
      supabaseAdmin
        .from("portfolio_snapshots")
        .select("total_value, cost_basis")
        .eq("user_id", userId)
        .eq("collection_id", c.id)
        .order("snapshot_date", { ascending: false })
        .limit(1)
        .maybeSingle(),
    ),
  );

  return collections.map((c, i) => ({
    ...c,
    itemCount: countResults[i].count ?? 0,
    totalValue: snapshotResults[i].data?.total_value ?? 0,
    costBasis: snapshotResults[i].data?.cost_basis ?? 0,
  }));
};

// ─── Ensure default collection exists ────────────────────────────────────────
// Called on first inventory load — idempotent

export const ensureDefaultCollection = async (
  userId: string,
): Promise<Collection> => {
  const { data: existing } = await supabaseAdmin
    .from("collections")
    .select("*")
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();

  if (existing) return existing;

  const { data, error } = await supabaseAdmin
    .from("collections")
    .insert({
      user_id: userId,
      name: "My Collection",
      is_default: true,
    })
    .select()
    .single();

  if (error) throw error;
  return data;
};

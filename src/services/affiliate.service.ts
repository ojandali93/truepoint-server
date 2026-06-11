// affiliate.service.ts
//
// Data access for affiliates + signup attribution.
//
// TODO: adjust this import to your existing SERVICE-ROLE Supabase client.
// Your backend already has one (it powers admin reads/writes that bypass RLS).
// Common locations: "../config/supabase", "../lib/supabaseAdmin", "../db/supabase".

import { supabase, supabaseAdmin } from "../lib";

const TABLE = "affiliates";

export interface AffiliateInput {
  name: string;
  slug?: string | null;
  type?: "vendor" | "creator" | "page" | "event" | "other";
  contact_name?: string | null;
  contact_email?: string | null;
  contact_phone?: string | null;
  instagram?: string | null;
  website?: string | null;
  notes?: string | null;
  active?: boolean;
}

const WRITABLE_FIELDS: (keyof AffiliateInput)[] = [
  "name",
  "slug",
  "type",
  "contact_name",
  "contact_email",
  "contact_phone",
  "instagram",
  "website",
  "notes",
  "active",
];

// Public — the trimmed list for the signup dropdown (active only).
export async function listActive() {
  const { data, error } = await supabase
    .from(TABLE)
    .select("id, name, slug, type")
    .eq("active", true)
    .order("name", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

// Admin — full rows + how many users signed up through each affiliate.
export async function listAllWithCounts() {
  const { data: affiliates, error } = await supabase
    .from(TABLE)
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw error;

  // Count signups per affiliate. Fine at current scale; if profiles grows large,
  // move this to a SQL aggregate / Postgres function (RPC).
  const { data: rows, error: cErr } = await supabase
    .from("profiles")
    .select("affiliation_id")
    .not("affiliation_id", "is", null);
  if (cErr) throw cErr;

  const counts = new Map<string, number>();
  for (const r of rows ?? []) {
    const id = (r as { affiliation_id: string }).affiliation_id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  return (affiliates ?? []).map((a: { id: string }) => ({
    ...a,
    signup_count: counts.get(a.id) ?? 0,
  }));
}

export async function getById(id: string) {
  const { data, error } = await supabase
    .from(TABLE)
    .select("*")
    .eq("id", id)
    .single();
  if (error) throw error;
  return data;
}

export async function create(input: AffiliateInput) {
  const row: Record<string, unknown> = {
    name: input.name,
    slug: input.slug ?? null,
    type: input.type ?? "vendor",
    contact_name: input.contact_name ?? null,
    contact_email: input.contact_email ?? null,
    contact_phone: input.contact_phone ?? null,
    instagram: input.instagram ?? null,
    website: input.website ?? null,
    notes: input.notes ?? null,
    active: input.active ?? true,
  };
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function update(id: string, input: AffiliateInput) {
  const patch: Record<string, unknown> = {};
  for (const f of WRITABLE_FIELDS) {
    if (input[f] !== undefined) patch[f] = input[f];
  }
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function remove(id: string) {
  // Hard delete. profiles.affiliation_id is ON DELETE SET NULL, and the
  // denormalized profiles.affiliation (name) is preserved, so historical
  // attribution survives the delete.
  const { error } = await supabaseAdmin.from(TABLE).delete().eq("id", id);
  if (error) throw error;
}

// Attaches the chosen affiliate to a user's profile (called right after signup).
// Captures the affiliate NAME too, so attribution is durable.
export async function setUserAffiliation(userId: string, affiliateId: string) {
  const { data: aff, error: aErr } = await supabase
    .from(TABLE)
    .select("id, name, active")
    .eq("id", affiliateId)
    .single();
  if (aErr || !aff) throw new Error("Affiliate not found");
  if (!aff.active) throw new Error("Affiliate is not active");

  const { data, error } = await supabase
    .from("profiles")
    .update({ affiliation_id: aff.id, affiliation: aff.name })
    .eq("id", userId)
    .select("id, affiliation_id, affiliation")
    .single();
  if (error) throw error;
  return data;
}

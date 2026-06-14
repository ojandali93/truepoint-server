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
  collector_rate?: number | null;
  pro_rate?: number | null;
  // ── Self-service application fields (Phase 0) ──
  // Multiple socials, e.g. { instagram, tiktok, youtube, twitter, facebook }.
  socials?: Record<string, string> | null;
  // The code the applicant *proposes*; the live unique `slug` is set on approval.
  requested_slug?: string | null;
  // Where the application came from: 'web' (public form) or 'app' (logged-in).
  source?: "web" | "app" | null;
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
  "collector_rate",
  "pro_rate",
  "socials",
  "requested_slug",
  "source",
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
  // Only set rates when explicitly provided, so the column defaults
  // (0.0500 / 0.0700) apply otherwise. Setting null would override the default.
  if (input.collector_rate !== undefined && input.collector_rate !== null)
    row.collector_rate = input.collector_rate;
  if (input.pro_rate !== undefined && input.pro_rate !== null)
    row.pro_rate = input.pro_rate;

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

// ── Self-service applications (Phase 1) ──────────────────────────────────────

export interface ApplicationInput {
  name?: string | null; // business name (display); falls back to person name
  contact_name?: string | null; // person's name
  contact_email?: string | null;
  contact_phone?: string | null;
  requested_slug?: string | null;
  socials?: Record<string, string> | null;
}

/** Lowercase, hyphenate, strip to [a-z0-9-]. Returns null if empty. */
export function normalizeSlug(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return s.length ? s : null;
}

/** The affiliate record (if any) linked to a user account. */
export async function getAffiliateByUserId(userId: string) {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

/**
 * Create a pending application. `userId` set → member branch (source 'app',
 * account linked, NOT active until approved). The DB guards
 * (one-open-application-per-email, one-affiliate-per-user) enforce uniqueness;
 * the controller maps their unique-violation errors to friendly messages.
 */
export async function applyAffiliate(
  input: ApplicationInput,
  userId?: string | null,
) {
  const personName = (input.contact_name ?? "").trim();
  const businessName = (input.name ?? "").trim();
  const displayName = businessName || personName;
  if (displayName.length < 2) {
    throw Object.assign(new Error("Name is required"), { status: 400 });
  }

  const row: Record<string, unknown> = {
    name: displayName,
    type: "creator",
    contact_name: personName || null,
    contact_email: input.contact_email ?? null,
    contact_phone: input.contact_phone ?? null,
    requested_slug: normalizeSlug(input.requested_slug),
    socials: input.socials ?? {},
    status: "pending",
    active: false, // not live until approved
    source: userId ? "app" : "web",
    user_id: userId ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .insert(row)
    .select("id, status")
    .single();
  if (error) throw error;
  return data;
}

/**
 * Approve a pending application: confirm/override the live slug, stamp
 * approved_at, optionally set rates, and flip the affiliate live (active=true).
 * Idempotency + collision guards throw status-tagged errors. Does NOT issue the
 * token / grant comp / send email — the controller orchestrates that based on
 * whether the applicant already has an account (user_id).
 */
export async function approveAffiliate(
  id: string,
  opts: { slug: string; collector_rate?: number; pro_rate?: number },
) {
  const current = await getById(id);
  if (!current) {
    throw Object.assign(new Error("Affiliate not found"), { status: 404 });
  }
  if (current.status !== "pending" || current.approved_at) {
    throw Object.assign(
      new Error("This application has already been processed"),
      { status: 409 },
    );
  }

  const slug = normalizeSlug(opts.slug);
  if (!slug) {
    throw Object.assign(new Error("A referral code (slug) is required"), {
      status: 400,
    });
  }

  // Collision guard: no other affiliate may hold this slug (case-insensitive).
  const { data: clash, error: clashErr } = await supabaseAdmin
    .from(TABLE)
    .select("id")
    .ilike("slug", slug)
    .neq("id", id)
    .limit(1);
  if (clashErr) throw clashErr;
  if (clash && clash.length > 0) {
    throw Object.assign(
      new Error(`The code "${slug}" is already in use — choose another`),
      { status: 409 },
    );
  }

  const patch: Record<string, unknown> = {
    slug,
    approved_at: new Date().toISOString(),
    active: true,
  };
  if (opts.collector_rate !== undefined && opts.collector_rate !== null)
    patch.collector_rate = opts.collector_rate;
  if (opts.pro_rate !== undefined && opts.pro_rate !== null)
    patch.pro_rate = opts.pro_rate;

  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Mark an affiliate active (member-approval branch, after linking exists). */
export async function setAffiliateActive(id: string) {
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update({ status: "active" })
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

/** Reject a pending application. */
export async function rejectAffiliate(id: string, reason?: string) {
  const current = await getById(id);
  if (!current) {
    throw Object.assign(new Error("Affiliate not found"), { status: 404 });
  }
  if (current.status !== "pending" || current.approved_at) {
    throw Object.assign(
      new Error("This application has already been processed"),
      { status: 409 },
    );
  }
  const patch: Record<string, unknown> = {
    status: "rejected",
    rejected_at: new Date().toISOString(),
    active: false,
  };
  if (reason && reason.trim()) {
    patch.notes = current.notes
      ? `${current.notes}\n[Rejected] ${reason.trim()}`
      : `[Rejected] ${reason.trim()}`;
  }
  const { data, error } = await supabaseAdmin
    .from(TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

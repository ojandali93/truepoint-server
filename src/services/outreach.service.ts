// src/services/outreach.service.ts
//
// Admin-only influencer/creator outreach CRM. Tracks the relationship BEFORE
// someone becomes an affiliate — every comment, like, and DM, plus stage
// and follow-up timing. Once a contact is ready for a code, this hands off
// to the EXISTING affiliate.service.ts rather than re-implementing
// code/rate/signup-count logic that already exists there.

import { supabaseAdmin } from "../lib/supabase";
import {
  create as createAffiliate,
  countSignupsForAffiliate,
  type AffiliateInput,
} from "./affiliate.service";

const CONTACTS_TABLE = "outreach_contacts";
const INTERACTIONS_TABLE = "outreach_interactions";

export const OUTREACH_STAGES = [
  "prospecting",
  "engaging",
  "messaging",
  "negotiating",
  "partnered",
  "declined",
  "cold",
] as const;
export type OutreachStage = (typeof OUTREACH_STAGES)[number];

export const OUTREACH_PLATFORMS = [
  "instagram",
  "tiktok",
  "youtube",
  "twitter",
  "facebook",
  "twitch",
  "other",
] as const;

export const INTERACTION_TYPES = [
  "comment",
  "like",
  "dm",
  "reply",
  "email",
  "call",
  "meeting",
  "other",
] as const;
export type InteractionType = (typeof INTERACTION_TYPES)[number];

// A contact is "due for follow-up" once next_follow_up_at has passed, or
// once it's been 14+ days since last contact with no follow-up date set at
// all (the staleness net for contacts nobody explicitly scheduled).
const STALE_AFTER_DAYS = 14;

const badRequest = (message: string) =>
  Object.assign(new Error(message), { status: 400 });
const notFound = (message: string) =>
  Object.assign(new Error(message), { status: 404 });

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OutreachContactInput {
  name: string;
  handle?: string | null;
  primaryPlatform?: string | null;
  socials?: Record<string, string> | null;
  followerCount?: number | null;
  niche?: string | null;
  stage?: OutreachStage;
  nextFollowUpAt?: string | null;
  notes?: string | null;
}

export interface OutreachInteractionInput {
  type: InteractionType;
  notes?: string | null;
  occurredAt?: string | null; // defaults to now() — set explicitly to backfill
}

const validateContactInput = (
  input: Partial<OutreachContactInput>,
  isCreate: boolean,
): void => {
  if (isCreate && (!input.name || !input.name.trim())) {
    throw badRequest("name is required");
  }
  if (
    input.primaryPlatform !== undefined &&
    input.primaryPlatform !== null &&
    !(OUTREACH_PLATFORMS as readonly string[]).includes(input.primaryPlatform)
  ) {
    throw badRequest(
      `primaryPlatform must be one of ${OUTREACH_PLATFORMS.join(", ")}`,
    );
  }
  if (input.stage !== undefined && !OUTREACH_STAGES.includes(input.stage)) {
    throw badRequest(`stage must be one of ${OUTREACH_STAGES.join(", ")}`);
  }
};

// ─── Contacts ───────────────────────────────────────────────────────────────

export interface OutreachContactRow {
  id: string;
  name: string;
  handle: string | null;
  primary_platform: string | null;
  socials: Record<string, string>;
  follower_count: number | null;
  niche: string | null;
  stage: OutreachStage;
  first_contacted_at: string | null;
  last_contacted_at: string | null;
  next_follow_up_at: string | null;
  affiliate_id: string | null;
  notes: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
  // Enriched, not stored:
  interactionCount: number;
  isDueForFollowUp: boolean;
  isStale: boolean;
  affiliateSignupCount: number | null; // null when not linked to an affiliate yet
}

export const listContacts = async (
  opts: {
    includeArchived?: boolean;
  } = {},
): Promise<OutreachContactRow[]> => {
  let query = supabaseAdmin
    .from(CONTACTS_TABLE)
    .select("*")
    .order("updated_at", { ascending: false });

  if (!opts.includeArchived) query = query.eq("archived", false);

  const { data: contacts, error } = await query;
  if (error) throw error;
  const rows = contacts ?? [];
  if (rows.length === 0) return [];

  // Interaction counts — one query for all contacts rather than N+1.
  const contactIds = rows.map((r) => r.id as string);
  const { data: interactionRows, error: intErr } = await supabaseAdmin
    .from(INTERACTIONS_TABLE)
    .select("contact_id")
    .in("contact_id", contactIds);
  if (intErr) throw intErr;

  const countByContact = new Map<string, number>();
  for (const r of interactionRows ?? []) {
    const id = (r as { contact_id: string }).contact_id;
    countByContact.set(id, (countByContact.get(id) ?? 0) + 1);
  }

  // Signup counts only for contacts actually linked to an affiliate —
  // reuses the existing affiliate service rather than re-deriving this.
  const affiliateIds = rows
    .map((r) => r.affiliate_id as string | null)
    .filter((id): id is string => !!id);
  const signupCountByAffiliate = new Map<string, number>();
  await Promise.all(
    affiliateIds.map(async (id) => {
      signupCountByAffiliate.set(id, await countSignupsForAffiliate(id));
    }),
  );

  const now = Date.now();
  const staleMs = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;

  return rows.map((r) => {
    const nextFollowUpAt = r.next_follow_up_at as string | null;
    const lastContactedAt = r.last_contacted_at as string | null;

    const isDueForFollowUp = nextFollowUpAt
      ? new Date(nextFollowUpAt).getTime() <= now
      : false;

    // Staleness is the net for contacts nobody scheduled a follow-up for —
    // if a follow-up IS scheduled, that date is the signal, not this.
    const isStale =
      !nextFollowUpAt &&
      !!lastContactedAt &&
      now - new Date(lastContactedAt).getTime() > staleMs &&
      r.stage !== "partnered" &&
      r.stage !== "declined" &&
      r.stage !== "cold";

    return {
      ...r,
      interactionCount: countByContact.get(r.id as string) ?? 0,
      isDueForFollowUp,
      isStale,
      affiliateSignupCount: r.affiliate_id
        ? (signupCountByAffiliate.get(r.affiliate_id as string) ?? 0)
        : null,
    } as OutreachContactRow;
  });
};

export const getContact = async (
  id: string,
): Promise<{
  contact: OutreachContactRow;
  interactions: OutreachInteractionRow[];
}> => {
  const { data: contact, error } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .select("*")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  if (!contact) throw notFound("Contact not found");

  const interactions = await listInteractions(id);

  const affiliateSignupCount = contact.affiliate_id
    ? await countSignupsForAffiliate(contact.affiliate_id as string)
    : null;

  const now = Date.now();
  const staleMs = STALE_AFTER_DAYS * 24 * 60 * 60 * 1000;
  const nextFollowUpAt = contact.next_follow_up_at as string | null;
  const lastContactedAt = contact.last_contacted_at as string | null;

  return {
    contact: {
      ...contact,
      interactionCount: interactions.length,
      isDueForFollowUp: nextFollowUpAt
        ? new Date(nextFollowUpAt).getTime() <= now
        : false,
      isStale:
        !nextFollowUpAt &&
        !!lastContactedAt &&
        now - new Date(lastContactedAt).getTime() > staleMs &&
        !["partnered", "declined", "cold"].includes(contact.stage as string),
      affiliateSignupCount,
    } as OutreachContactRow,
    interactions,
  };
};

export const createContact = async (
  input: OutreachContactInput,
): Promise<OutreachContactRow> => {
  validateContactInput(input, true);

  const { data, error } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .insert({
      name: input.name.trim(),
      handle: input.handle ?? null,
      primary_platform: input.primaryPlatform ?? null,
      socials: input.socials ?? {},
      follower_count: input.followerCount ?? null,
      niche: input.niche ?? null,
      stage: input.stage ?? "prospecting",
      next_follow_up_at: input.nextFollowUpAt ?? null,
      notes: input.notes ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  return {
    ...data,
    interactionCount: 0,
    isDueForFollowUp: false,
    isStale: false,
    affiliateSignupCount: null,
  } as OutreachContactRow;
};

export const updateContact = async (
  id: string,
  patch: Partial<OutreachContactInput> & { archived?: boolean },
): Promise<void> => {
  validateContactInput(patch, false);

  const update: Record<string, unknown> = {};
  if (patch.name !== undefined) update.name = patch.name.trim();
  if (patch.handle !== undefined) update.handle = patch.handle;
  if (patch.primaryPlatform !== undefined)
    update.primary_platform = patch.primaryPlatform;
  if (patch.socials !== undefined) update.socials = patch.socials ?? {};
  if (patch.followerCount !== undefined)
    update.follower_count = patch.followerCount;
  if (patch.niche !== undefined) update.niche = patch.niche;
  if (patch.stage !== undefined) update.stage = patch.stage;
  if (patch.nextFollowUpAt !== undefined)
    update.next_follow_up_at = patch.nextFollowUpAt;
  if (patch.notes !== undefined) update.notes = patch.notes;
  if (patch.archived !== undefined) update.archived = patch.archived;

  if (Object.keys(update).length === 0) return;

  const { error } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .update(update)
    .eq("id", id);
  if (error) throw error;
};

export const deleteContact = async (id: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .delete()
    .eq("id", id);
  if (error) throw error;
};

// ─── Interactions ───────────────────────────────────────────────────────────

export interface OutreachInteractionRow {
  id: string;
  contact_id: string;
  type: InteractionType;
  notes: string | null;
  occurred_at: string;
  created_at: string;
}

export const listInteractions = async (
  contactId: string,
): Promise<OutreachInteractionRow[]> => {
  const { data, error } = await supabaseAdmin
    .from(INTERACTIONS_TABLE)
    .select("*")
    .eq("contact_id", contactId)
    .order("occurred_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
};

export const logInteraction = async (
  contactId: string,
  input: OutreachInteractionInput,
): Promise<OutreachInteractionRow> => {
  if (!INTERACTION_TYPES.includes(input.type)) {
    throw badRequest(`type must be one of ${INTERACTION_TYPES.join(", ")}`);
  }

  // Confirm the contact exists first — a bad contactId would otherwise fail
  // as a raw FK-violation error instead of a clean 404.
  const { data: contact, error: contactErr } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .select("id")
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) throw contactErr;
  if (!contact) throw notFound("Contact not found");

  const { data, error } = await supabaseAdmin
    .from(INTERACTIONS_TABLE)
    .insert({
      contact_id: contactId,
      type: input.type,
      notes: input.notes ?? null,
      occurred_at: input.occurredAt ?? new Date().toISOString(),
    })
    .select("*")
    .single();
  if (error) throw error;
  // first_contacted_at / last_contacted_at on the parent contact are kept
  // correct by the DB trigger — no application-side update needed here.
  return data;
};

export const deleteInteraction = async (id: string): Promise<void> => {
  const { error } = await supabaseAdmin
    .from(INTERACTIONS_TABLE)
    .delete()
    .eq("id", id);
  if (error) throw error;
};

// ─── Convert to affiliate ───────────────────────────────────────────────────
//
// The "create a code for them" step. Reuses affiliate.service.ts's own
// create() rather than re-implementing rate/slug/status logic — this
// function's only job is to also link the new affiliate back onto the
// outreach contact and bump its stage, in one call.

export const convertToAffiliate = async (
  contactId: string,
  affiliateInput: AffiliateInput,
): Promise<{ affiliateId: string }> => {
  const { data: contact, error: contactErr } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .select("id, affiliate_id")
    .eq("id", contactId)
    .maybeSingle();
  if (contactErr) throw contactErr;
  if (!contact) throw notFound("Contact not found");
  if (contact.affiliate_id) {
    throw badRequest("This contact is already linked to an affiliate");
  }

  const affiliate = await createAffiliate({
    type: "creator",
    ...affiliateInput,
  });

  const { error: linkErr } = await supabaseAdmin
    .from(CONTACTS_TABLE)
    .update({ affiliate_id: affiliate.id, stage: "partnered" })
    .eq("id", contactId);
  if (linkErr) throw linkErr;

  return { affiliateId: affiliate.id as string };
};

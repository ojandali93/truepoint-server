import { z } from "zod";

const GRADING_COMPANIES = ["PSA", "BGS", "CGC", "TAG"] as const;
const CURRENCIES = ["USD", "EUR", "GBP", "CAD", "AUD", "JPY"] as const;
const DEVICE_TYPES = ["ios", "android", "web"] as const;
const PLATFORMS = ["web", "ios", "android"] as const;

export const createProfileSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username cannot exceed 30 characters")
    .regex(
      /^[a-zA-Z0-9_]+$/,
      "Username can only contain letters, numbers, and underscores",
    ),
  full_name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url("Invalid avatar URL").optional(),
  currency: z.enum(CURRENCIES).default("USD"),
  preferred_grading_company: z.enum(GRADING_COMPANIES).default("PSA"),
  // PostHog integration (2026-09-02) — the client-generated durable
  // anonymous id, sent on this same profile-creation call so the
  // pre-signup -> post-signup PostHog identity stitch is also joinable
  // internally. Optional: a client that hasn't shipped this yet, or one
  // whose PostHog env vars are unset (SDK no-ops, but the local id still
  // exists and can still be sent), shouldn't fail profile creation over it.
  posthog_anonymous_id: z.string().max(100).optional(),
});

export const updateProfileSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/)
    .optional(),
  full_name: z.string().min(1).max(100).optional(),
  avatar_url: z.string().url().optional(),
  currency: z.enum(CURRENCIES).optional(),
  preferred_grading_company: z.enum(GRADING_COMPANIES).optional(),
  show_market_values: z.boolean().optional(),

  // ── NEW: collector-detail fields (previously not editable) ──
  favorite_pokemon: z.string().max(100).optional(),
  favorite_set: z.string().max(100).optional(),
  collecting_years: z.string().max(50).optional(),
  collection_type: z.enum(["sealed", "unsealed", "both"]).optional(),
  collector_style: z.enum(["grading", "singles", "both"]).optional(),

  // PostHog integration (2026-09-02) — web's signup flow has no POST
  // /users/me call to piggyback on (profile creation there happens via the
  // handle_new_user DB trigger on supabase.auth.signUp(), not an explicit
  // API call — see createProfileSchema's comment for the mobile side,
  // which does have that call site). Web instead backfills this via PUT
  // /me right after signUp() resolves and a session exists. Same
  // optionality reasoning as createProfileSchema.
  posthog_anonymous_id: z.string().max(100).optional(),
});

export const createNotificationSettingsSchema = z.object({
  notify_price_alerts: z.boolean().default(true),
  notify_grading_updates: z.boolean().default(true),
  notify_marketing: z.boolean().default(false),
});

export const updateNotificationSettingsSchema = z
  .object({
    notify_price_alerts: z.boolean().optional(),
    notify_grading_updates: z.boolean().optional(),
    notify_marketing: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
  });

export const registerDeviceSchema = z.object({
  device_token: z.string().min(10, "Invalid device token"),
  device_type: z.enum(DEVICE_TYPES).optional(),
  device_name: z.string().max(100).optional(),
});

export const logActivitySchema = z.object({
  event_name: z.string().min(1).max(100),
  metadata: z.record(z.string(), z.unknown()).optional(),
  platform: z.enum(PLATFORMS).optional(),
});

export const searchUsernameSchema = z.object({
  username: z.string().min(1).max(30),
});

export const adminUpdateUserSchema = z.object({
  username: z.string().min(3).max(30).optional(),
  full_name: z.string().max(100).optional(),
  currency: z.enum(CURRENCIES).optional(),
  preferred_grading_company: z.enum(GRADING_COMPANIES).optional(),
  show_market_values: z.boolean().optional(),
});

export const createAdminUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, "Password must be at least 8 characters"),
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/),
  full_name: z.string().max(100).optional(),
});

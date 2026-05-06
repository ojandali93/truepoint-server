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
  is_pro_member: z.boolean().optional(),
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

import { logError } from "../lib/Logger";
import * as UserRepository from "../repositories/user.repository";
import { Profile, NotificationSettings, UserDevice } from "../types/user.types";

// ─── Profile ─────────────────────────────────────────────────────────────────

export const getProfileById = async (id: string): Promise<Profile> => {
  const profile = await UserRepository.findProfileById(id);
  if (!profile) throw { status: 404, message: "Profile not found" };
  return profile;
};

export const getPublicProfile = async (id: string) => {
  const profile = await UserRepository.findProfileById(id);
  if (!profile) throw { status: 404, message: "Profile not found" };
  const { show_market_values, is_pro_member, currency, ...publicFields } =
    profile;
  return publicFields;
};

export const searchByUsername = async (username: string) => {
  const profile = await UserRepository.findProfileByUsername(username);
  if (!profile) throw { status: 404, message: "User not found" };
  return profile;
};

export const createProfile = async (
  userId: string,
  payload: Partial<Profile>,
): Promise<Profile> => {
  const existing = await UserRepository.findProfileById(userId);
  if (existing)
    throw { status: 409, message: "Profile already exists for this user" };
  return UserRepository.createProfile(userId, payload);
};

export const updateProfile = async (
  userId: string,
  payload: Partial<Profile>,
): Promise<Profile> => {
  try {
    console.log("updateProfile payload", payload, userId);
    return await UserRepository.updateProfile(userId, payload);
  } catch (err: any) {
    await logError({
      source: "update-profile", // ← change per controller
      message: err?.message ?? "Unknown error",
      error: err,
      userId: null,
      requestPath: "",
      requestMethod: "",
      metadata: {},
    });
    console.log("updateProfile error", err);
    if (err.code === "23505")
      throw { status: 409, message: "Username is already taken" };
    throw err;
  }
};

export const deleteAccount = async (userId: string): Promise<void> => {
  await UserRepository.deleteProfileById(userId);
};

// ─── Notification Settings ────────────────────────────────────────────────────

export const getNotificationSettings = async (
  userId: string,
): Promise<NotificationSettings> => {
  const settings = await UserRepository.findNotificationSettings(userId);
  if (!settings)
    throw { status: 404, message: "Notification settings not found" };
  return settings;
};

export const createNotificationSettings = async (
  userId: string,
  payload: Partial<NotificationSettings>,
): Promise<NotificationSettings> => {
  // Idempotent: if the row already exists (auto-created at signup),
  // treat this as an update rather than failing with 409.
  const existing = await UserRepository.findNotificationSettings(userId);
  if (existing) {
    return UserRepository.updateNotificationSettings(userId, payload);
  }
  return UserRepository.createNotificationSettings(userId, payload);
};

export const updateNotificationSettings = async (
  userId: string,
  payload: Partial<NotificationSettings>,
): Promise<NotificationSettings> => {
  return UserRepository.updateNotificationSettings(userId, payload);
};

// ─── Devices ──────────────────────────────────────────────────────────────────

export const getDevices = async (userId: string): Promise<UserDevice[]> => {
  return UserRepository.findDevicesByUserId(userId);
};

export const registerDevice = async (
  userId: string,
  payload: Pick<UserDevice, "device_token" | "device_type" | "device_name">,
): Promise<UserDevice> => {
  return UserRepository.upsertDevice(userId, payload);
};

export const removeDevice = async (
  deviceId: string,
  userId: string,
): Promise<void> => {
  await UserRepository.deleteDevice(deviceId, userId);
};

export const pingDevice = async (
  deviceId: string,
  userId: string,
): Promise<UserDevice> => {
  return UserRepository.pingDevice(deviceId, userId);
};

// ─── Activity ─────────────────────────────────────────────────────────────────

export const getActivityLogs = async (userId: string, page = 1) => {
  const limit = 50;
  const offset = (page - 1) * limit;
  return UserRepository.findActivityByUserId(userId, limit, offset);
};

export const logActivity = async (
  userId: string,
  payload: {
    event_name: string;
    metadata?: Record<string, unknown>;
    platform?: string;
  },
): Promise<void> => {
  await UserRepository.insertActivityLog(userId, {
    event_name: payload.event_name,
    metadata: payload.metadata ?? null,
    platform: payload.platform ?? null,
  });
};

// ─── Admin ────────────────────────────────────────────────────────────────────

export const adminGetAllUsers = async (page = 1) => {
  const limit = 50;
  const offset = (page - 1) * limit;
  return UserRepository.findAllProfiles(limit, offset);
};

export const adminCreateStandardUser = async (
  email: string,
  password: string,
  username: string,
  fullName?: string,
) => {
  const authUser = await UserRepository.adminCreateUser(email, password, false);
  const profile = await UserRepository.createProfile(authUser.id, {
    username,
    full_name: fullName,
  });
  await UserRepository.createNotificationSettings(authUser.id, {});
  return { user: authUser, profile };
};

export const adminCreateAdminUser = async (
  email: string,
  password: string,
  username: string,
  fullName?: string,
) => {
  const authUser = await UserRepository.adminCreateUser(email, password, true);
  const profile = await UserRepository.createProfile(authUser.id, {
    username,
    full_name: fullName,
  });
  return { user: authUser, profile };
};

export const adminUpdateUser = async (
  userId: string,
  payload: Partial<Profile>,
): Promise<Profile> => {
  try {
    return await UserRepository.updateProfile(userId, payload);
  } catch (err: any) {
    if (err.code === "23505")
      throw { status: 409, message: "Username is already taken" };
    throw err;
  }
};

export const adminToggleProMember = async (userId: string, isPro: boolean) => {
  return UserRepository.adminToggleProMember(userId, isPro);
};

// ─── Account deactivation ─────────────────────────────────────────────────────

import { supabaseAdmin } from "../lib/supabase";
import { cancelSubscription } from "./billing.service";

/**
 * Soft-delete an account:
 *  - cancels any active Stripe subscription at period end (user keeps access until then)
 *  - signs out all active devices
 *  - revokes all auth sessions
 *  - flags the profile as deactivated (we don't delete data so we can comply with any
 *    future legal requests / let user reactivate if they change their mind within 30 days)
 *
 * Hard delete (full data removal) is a separate compliance flow we'd build later if needed.
 */
export const deactivateAccount = async (userId: string): Promise<void> => {
  // 1. Cancel subscription if any (don't fail the deactivation if none exists)
  try {
    await cancelSubscription(userId);
  } catch (err: any) {
    if (err?.status !== 404) {
      console.error("[deactivate] cancel subscription failed:", err);
    }
  }

  // 2. Mark all devices inactive
  await supabaseAdmin
    .from("user_devices")
    .update({ is_active: false, logged_out_at: new Date().toISOString() })
    .eq("user_id", userId)
    .eq("is_active", true);

  // 3. Stamp the profile so the gate / login can refuse future access
  await supabaseAdmin
    .from("profiles")
    .update({
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  // 4. Sign out all Supabase sessions for this user
  // (admin API endpoint — invalidates all refresh tokens)
  try {
    await supabaseAdmin.auth.admin.signOut(userId, "global");
  } catch (err) {
    console.error("[deactivate] admin signOut failed:", err);
  }
};

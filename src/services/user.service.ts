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
  const { show_market_values, currency, ...publicFields } = profile;
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
  // Idempotent: a profile row may have been auto-created by the
  // `handle_new_user` DB trigger when the auth.users row was inserted.
  // In that case, treat this as the user filling in their profile details
  // for the first time — update the existing row rather than 409.
  const existing = await UserRepository.findProfileById(userId);
  if (existing) {
    try {
      return await UserRepository.updateProfile(userId, payload);
    } catch (err: any) {
      // Username uniqueness violation surfaces as Postgres error 23505
      if (err?.code === "23505") {
        throw { status: 409, message: "Username is already taken" };
      }
      throw err;
    }
  }
  return UserRepository.createProfile(userId, payload);
};

export const updateProfile = async (
  userId: string,
  payload: Partial<Profile>,
): Promise<Profile> => {
  try {
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
    if (err.code === "23505")
      throw { status: 409, message: "Username is already taken" };
    throw err;
  }
};

// Replace the existing deleteAccount in src/services/user.service.ts with this.
// Requires: import { supabaseAdmin } from "../lib/supabase";  (already imported there)
//           import * as UserRepository from "../repositories/user.repository";

// Buckets that store files under a top-level folder named after the user id.
// NOTE: names are case/space-sensitive and must match exactly.
const USER_STORAGE_BUCKETS = [
  "Profile Pictures",
  "Ai Grading Images",
  "Centering Images",
];

/**
 * Recursively delete every object under `${userId}/` in a bucket.
 * Supabase Storage has no "delete folder" — you list paths then remove them.
 */
const deleteUserBucketFolder = async (
  bucket: string,
  userId: string,
): Promise<void> => {
  // List everything under the user's folder (one level; recurse if you nest deeper).
  const { data: entries, error: listErr } = await supabaseAdmin.storage
    .from(bucket)
    .list(userId, { limit: 1000 });

  if (listErr) {
    console.error(
      `[deleteAccount] list failed for ${bucket}/${userId}:`,
      listErr,
    );
    return; // don't block account deletion on storage cleanup
  }
  if (!entries || entries.length === 0) return;

  // Build full paths. (If you store nested subfolders, expand this to recurse.)
  const paths = entries
    .filter((e) => e.name) // skip the implicit folder placeholder
    .map((e) => `${userId}/${e.name}`);

  if (paths.length === 0) return;

  const { error: rmErr } = await supabaseAdmin.storage
    .from(bucket)
    .remove(paths);
  if (rmErr) {
    console.error(
      `[deleteAccount] remove failed for ${bucket}/${userId}:`,
      rmErr,
    );
  }
};

export const deleteAccount = async (userId: string): Promise<void> => {
  // 1. Best-effort storage cleanup FIRST. DB cascades never touch Storage, so
  //    the user's images must be removed explicitly. We do this before the auth
  //    delete so failures are logged while we still have a valid reference; we
  //    never let a storage hiccup block the actual account deletion.
  for (const bucket of USER_STORAGE_BUCKETS) {
    try {
      await deleteUserBucketFolder(bucket, userId);
    } catch (err) {
      console.error(
        `[deleteAccount] storage cleanup error for ${bucket}:`,
        err,
      );
    }
  }

  // 2. Delete the auth user. With ON DELETE CASCADE now in place, this atomically
  //    removes the profiles row and ALL user-data rows (collections, inventory,
  //    subscriptions, ai_grading_reports, centering_reports, grading_submissions,
  //    feedback, notification_settings, master_set_*, portfolio_snapshots,
  //    user_devices) in a single transaction. Telemetry/audit rows
  //    (activity_logs, error_logs, user_activity_logs) are retained with the
  //    user pointer set to NULL.
  await UserRepository.deleteProfileById(userId); // -> supabaseAdmin.auth.admin.deleteUser(userId)
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

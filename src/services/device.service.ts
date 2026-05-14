// src/services/device.service.ts
//
// Tracks user devices for session visibility + push notification readiness.
// Pattern: upsert on login, mark inactive on logout. Never delete — preserves
// the audit trail. The "Active sessions" UI filters on is_active = true.

import { supabaseAdmin } from "../lib/supabase";

export interface DeviceRecord {
  id: string;
  userId: string;
  deviceId: string | null;
  deviceType: string | null;
  deviceName: string | null;
  browser: string | null;
  os: string | null;
  ipAddress: string | null;
  pushToken: string | null;
  pushProvider: string | null;
  isActive: boolean;
  firstSeenAt: string | null;
  lastLoginAt: string | null;
  lastSeen: string | null;
  loggedOutAt: string | null;
}

const mapRow = (row: any): DeviceRecord => ({
  id: row.id,
  userId: row.user_id,
  deviceId: row.device_id,
  deviceType: row.device_type,
  deviceName: row.device_name,
  browser: row.browser,
  os: row.os,
  ipAddress: row.ip_address,
  pushToken: row.push_token,
  pushProvider: row.push_provider,
  isActive: row.is_active,
  firstSeenAt: row.first_seen_at,
  lastLoginAt: row.last_login_at,
  lastSeen: row.last_seen,
  loggedOutAt: row.logged_out_at,
});

// ─── Register or update a device on login ───────────────────────────────────

export const registerDevice = async (
  userId: string,
  input: {
    deviceId: string;
    deviceType?: string;
    deviceName?: string;
    browser?: string;
    os?: string;
    ipAddress?: string;
    pushToken?: string;
    pushProvider?: "fcm" | "apns" | "web";
  },
): Promise<DeviceRecord> => {
  if (!input.deviceId) {
    throw { status: 400, message: "device_id is required" };
  }

  const now = new Date().toISOString();

  // Look up existing record for this user+device
  const { data: existing } = await supabaseAdmin
    .from("user_devices")
    .select("id, first_seen_at")
    .eq("user_id", userId)
    .eq("device_id", input.deviceId)
    .maybeSingle();

  if (existing) {
    // Update the existing record
    const { data, error } = await supabaseAdmin
      .from("user_devices")
      .update({
        device_type: input.deviceType ?? null,
        device_name: input.deviceName ?? null,
        browser: input.browser ?? null,
        os: input.os ?? null,
        ip_address: input.ipAddress ?? null,
        push_token: input.pushToken ?? null,
        push_provider: input.pushProvider ?? null,
        is_active: true,
        last_login_at: now,
        last_seen: now,
        logged_out_at: null,
      })
      .eq("id", existing.id)
      .select()
      .single();
    if (error) throw error;
    return mapRow(data);
  }

  // Brand new device
  const { data, error } = await supabaseAdmin
    .from("user_devices")
    .insert({
      user_id: userId,
      device_id: input.deviceId,
      device_type: input.deviceType ?? null,
      device_name: input.deviceName ?? null,
      browser: input.browser ?? null,
      os: input.os ?? null,
      ip_address: input.ipAddress ?? null,
      push_token: input.pushToken ?? null,
      push_provider: input.pushProvider ?? null,
      is_active: true,
      first_seen_at: now,
      last_login_at: now,
      last_seen: now,
    })
    .select()
    .single();

  if (error) throw error;
  return mapRow(data);
};

// ─── Mark a device inactive on logout ───────────────────────────────────────

export const deactivateDevice = async (
  userId: string,
  deviceId: string,
): Promise<void> => {
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("user_devices")
    .update({
      is_active: false,
      logged_out_at: now,
      last_seen: now,
    })
    .eq("user_id", userId)
    .eq("device_id", deviceId);

  if (error) throw error;
};

// ─── User listing their own devices ─────────────────────────────────────────

export const listUserDevices = async (
  userId: string,
  activeOnly = false,
): Promise<DeviceRecord[]> => {
  let q = supabaseAdmin
    .from("user_devices")
    .select("*")
    .eq("user_id", userId)
    .order("last_login_at", { ascending: false });

  if (activeOnly) q = q.eq("is_active", true);

  const { data, error } = await q;
  if (error) throw error;
  return (data ?? []).map(mapRow);
};

// ─── Sign out a specific device (e.g. from settings) ────────────────────────

export const revokeDevice = async (
  userId: string,
  deviceRowId: string,
): Promise<void> => {
  // Ownership check is implicit — we filter on user_id below
  const now = new Date().toISOString();
  const { error } = await supabaseAdmin
    .from("user_devices")
    .update({
      is_active: false,
      logged_out_at: now,
    })
    .eq("id", deviceRowId)
    .eq("user_id", userId);

  if (error) throw error;
};

import { supabase, supabaseAdmin } from '../lib/supabase';
import {
  Profile,
  NotificationSettings,
  UserDevice,
  UserActivityLog,
} from '../types/user.types';

// ─── Profile ─────────────────────────────────────────────────────────────────

export const findProfileById = async (id: string): Promise<Profile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw error;
  return data;
};

export const findProfileByUsername = async (
  username: string
): Promise<Profile | null> => {
  const { data, error } = await supabase
    .from('profiles')
    .select(
      'id, username, full_name, avatar_url, currency, preferred_grading_company, show_market_values, is_pro_member, created_at, updated_at'
    )
    .ilike('username', username)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const createProfile = async (
  id: string,
  payload: Partial<Profile>
): Promise<Profile> => {
  const { data, error } = await supabase
    .from('profiles')
    .insert({ id, ...payload })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateProfile = async (
  id: string,
  payload: Partial<Profile>
): Promise<Profile> => {
  const { data, error } = await supabase
    .from('profiles')
    .update({ ...payload, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteProfileById = async (id: string): Promise<void> => {
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) throw error;
};

// ─── Notification Settings ────────────────────────────────────────────────────

export const findNotificationSettings = async (
  userId: string
): Promise<NotificationSettings | null> => {
  const { data, error } = await supabase
    .from('notification_settings')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error && error.code !== 'PGRST116') throw error;
  return data;
};

export const createNotificationSettings = async (
  userId: string,
  payload: Partial<NotificationSettings>
): Promise<NotificationSettings> => {
  const { data, error } = await supabase
    .from('notification_settings')
    .insert({ user_id: userId, ...payload })
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const updateNotificationSettings = async (
  userId: string,
  payload: Partial<NotificationSettings>
): Promise<NotificationSettings> => {
  const { data, error } = await supabase
    .from('notification_settings')
    .update(payload)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ─── Devices ──────────────────────────────────────────────────────────────────

export const findDevicesByUserId = async (userId: string): Promise<UserDevice[]> => {
  const { data, error } = await supabase
    .from('user_devices')
    .select('*')
    .eq('user_id', userId)
    .order('last_seen', { ascending: false });
  if (error) throw error;
  return data ?? [];
};

export const upsertDevice = async (
  userId: string,
  payload: Pick<UserDevice, 'device_token' | 'device_type' | 'device_name'>
): Promise<UserDevice> => {
  const { data, error } = await supabase
    .from('user_devices')
    .upsert(
      { user_id: userId, ...payload, last_seen: new Date().toISOString() },
      { onConflict: 'user_id,device_token' }
    )
    .select()
    .single();
  if (error) throw error;
  return data;
};

export const deleteDevice = async (deviceId: string, userId: string): Promise<void> => {
  const { error } = await supabase
    .from('user_devices')
    .delete()
    .eq('id', deviceId)
    .eq('user_id', userId);
  if (error) throw error;
};

export const pingDevice = async (deviceId: string, userId: string): Promise<UserDevice> => {
  const { data, error } = await supabase
    .from('user_devices')
    .update({ last_seen: new Date().toISOString() })
    .eq('id', deviceId)
    .eq('user_id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

// ─── Activity Logs ────────────────────────────────────────────────────────────

export const findActivityByUserId = async (
  userId: string,
  limit = 50,
  offset = 0
): Promise<UserActivityLog[]> => {
  const { data, error } = await supabase
    .from('user_activity_logs')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
};

export const insertActivityLog = async (
  userId: string,
  payload: Pick<UserActivityLog, 'event_name' | 'metadata' | 'platform'>
): Promise<void> => {
  const { error } = await supabase
    .from('user_activity_logs')
    .insert({ user_id: userId, ...payload });
  if (error) throw error;
};

// ─── Admin ────────────────────────────────────────────────────────────────────

export const findAllProfiles = async (limit = 50, offset = 0): Promise<Profile[]> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  return data ?? [];
};

export const adminCreateUser = async (
  email: string,
  password: string,
  isAdmin = false
) => {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    app_metadata: { role: isAdmin ? 'admin' : 'user' },
  });
  if (error) throw error;
  return data.user;
};

export const adminToggleProMember = async (
  userId: string,
  isPro: boolean
): Promise<Profile> => {
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .update({ is_pro_member: isPro, updated_at: new Date().toISOString() })
    .eq('id', userId)
    .select()
    .single();
  if (error) throw error;
  return data;
};

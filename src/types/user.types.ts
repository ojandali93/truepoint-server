import { Request } from 'express';

export interface Profile {
  id: string;
  username: string | null;
  full_name: string | null;
  avatar_url: string | null;
  currency: string;
  preferred_grading_company: string;
  show_market_values: boolean;
  is_pro_member: boolean;
  created_at: string;
  updated_at: string;
}

export interface NotificationSettings {
  user_id: string;
  notify_price_alerts: boolean;
  notify_grading_updates: boolean;
  notify_marketing: boolean;
}

export interface UserDevice {
  id: string;
  user_id: string;
  device_token: string;
  device_type: string | null;
  device_name: string | null;
  last_seen: string;
}

export interface UserActivityLog {
  id: string;
  user_id: string;
  event_name: string;
  metadata: Record<string, unknown> | null;
  platform: string | null;
  created_at: string;
}

export interface AuthUser {
  id: string;
  email: string;
  role: 'user' | 'admin';
}

export interface AuthenticatedRequest extends Request {
  user: AuthUser;
}

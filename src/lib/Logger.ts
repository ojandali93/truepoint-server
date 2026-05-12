// src/lib/logger.ts
// Shared logging utilities — drop logError() into every catch block,
// logActivity() into any significant user action.
// All writes go to Supabase via supabaseAdmin (bypasses RLS).

import { supabaseAdmin } from "./supabase";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ErrorSeverity = "warning" | "error" | "critical";

export interface LogErrorParams {
  source: string; // 'ai_grading', 'price_sync', 'inventory', etc.
  message: string;
  error?: unknown; // the raw error — stack trace extracted automatically
  userId?: string | null;
  severity?: ErrorSeverity;
  requestPath?: string;
  requestMethod?: string;
  requestBody?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LogActivityParams {
  userId?: string | null;
  action: string; // 'inventory.add', 'grading.submit', 'auth.login'
  resourceType?: string; // 'card', 'inventory_item', 'grading_submission'
  resourceId?: string;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  durationMs?: number;
}

// ─── logError ─────────────────────────────────────────────────────────────────
// Call this in every catch block across the backend.
//
// Usage:
//   } catch (err: any) {
//     await logError({ source: 'inventory', message: err.message, error: err, userId: req.userId });
//     res.status(500).json({ error: err.message });
//   }

export const logError = async (params: LogErrorParams): Promise<void> => {
  try {
    const stackTrace =
      params.error instanceof Error ? (params.error.stack ?? null) : null;

    const message =
      params.message ||
      (params.error instanceof Error
        ? params.error.message
        : String(params.error));

    await supabaseAdmin.from("error_logs").insert({
      user_id: params.userId ?? null,
      severity: params.severity ?? "error",
      source: params.source,
      message,
      stack_trace: stackTrace,
      request_path: params.requestPath ?? null,
      request_method: params.requestMethod ?? null,
      request_body: params.requestBody ?? null,
      metadata: params.metadata ?? null,
    });
  } catch (loggingErr) {
    // Never let the logger crash the app — just console it
    console.error("[Logger] Failed to write error log:", loggingErr);
  }
};

// ─── logActivity ──────────────────────────────────────────────────────────────
// Call this for significant user actions you want audited.
//
// Usage:
//   await logActivity({
//     userId: req.userId,
//     action: 'inventory.add',
//     resourceType: 'inventory_item',
//     resourceId: newItem.id,
//     metadata: { cardName: card.name, itemType: 'graded_card' },
//   });

export const logActivity = async (params: LogActivityParams): Promise<void> => {
  try {
    await supabaseAdmin.from("activity_logs").insert({
      user_id: params.userId ?? null,
      action: params.action,
      resource_type: params.resourceType ?? null,
      resource_id: params.resourceId ?? null,
      metadata: params.metadata ?? null,
      ip_address: params.ipAddress ?? null,
      user_agent: params.userAgent ?? null,
      duration_ms: params.durationMs ?? null,
    });
  } catch (loggingErr) {
    console.error("[Logger] Failed to write activity log:", loggingErr);
  }
};

// ─── extractRequestContext ─────────────────────────────────────────────────────
// Helper to pull common fields from an Express Request for logging.
//
// Usage:
//   const ctx = extractRequestContext(req);
//   await logError({ ...ctx, source: 'inventory', message: err.message, error: err });

export const extractRequestContext = (req: {
  path?: string;
  method?: string;
  body?: unknown;
  headers?: Record<string, string | string[] | undefined>;
  ip?: string;
}) => ({
  requestPath: req.path ?? null,
  requestMethod: req.method ?? null,
  requestBody: sanitizeBody(req.body),
  ipAddress: req.ip ?? null,
  userAgent: (req.headers?.["user-agent"] as string) ?? null,
});

// Strip sensitive fields before storing request body
const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "secret",
  "api_key",
  "apiKey",
  "authorization",
  "credit_card",
  "card_number",
  "cvv",
]);

function sanitizeBody(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== "object") return null;
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    clean[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? "[REDACTED]" : value;
  }
  return clean;
}

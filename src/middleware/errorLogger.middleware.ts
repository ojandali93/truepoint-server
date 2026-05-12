// src/middleware/errorLogger.middleware.ts
// Global Express error handler — catches any unhandled error thrown in a route
// and logs it to the error_logs table before sending the response.
//
// Register LAST in app.ts:
//   app.use(errorLoggerMiddleware);

import { Request, Response, NextFunction } from "express";
import { logError } from "../lib/Logger";

// ─── Global unhandled error middleware ────────────────────────────────────────
// Catches errors passed via next(err) or thrown inside async routes
// that are wrapped with asyncHandler.

export const errorLoggerMiddleware = async (
  err: unknown,
  req: Request,
  res: Response,
  _next: NextFunction,
): Promise<void> => {
  const message =
    err instanceof Error ? err.message : String(err) || "Unknown error";

  const severity =
    res.statusCode >= 500
      ? "critical"
      : res.statusCode >= 400
        ? "warning"
        : "error";

  // Log to DB asynchronously — don't await to avoid delaying the response
  logError({
    source: "unhandled",
    message,
    error: err,
    userId: (req as any).userId ?? null,
    severity,
    requestPath: req.path,
    requestMethod: req.method,
    requestBody: req.body,
    metadata: {
      statusCode: res.statusCode,
      params: req.params,
      query: req.query,
    },
  }).catch(() => {}); // logger never throws

  const statusCode =
    res.statusCode && res.statusCode !== 200 ? res.statusCode : 500;

  if (!res.headersSent) {
    res.status(statusCode).json({
      error: message,
      message: "An unexpected error occurred.",
    });
  }
};

// ─── asyncHandler ─────────────────────────────────────────────────────────────
// Wraps async route handlers so thrown errors are forwarded to errorLoggerMiddleware.
//
// Usage:
//   router.post('/foo', asyncHandler(async (req, res) => {
//     // any thrown error will be caught and logged automatically
//   }));

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res, next).catch(next);
  };

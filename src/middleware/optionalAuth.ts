import { Request, Response, NextFunction } from "express";
import { supabase } from "../lib/supabase";
import { AuthenticatedRequest } from "../types/user.types";

/**
 * Like authenticateUser, but never rejects. If a valid Bearer token is present,
 * attaches req.user; if it's missing or invalid, the request continues
 * unauthenticated. Used by endpoints that serve both signed-in and anonymous
 * callers (e.g. POST /affiliates/apply: members vs guests).
 */
export const optionalAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const { data, error } = await supabase.auth.getUser(token);
      if (!error && data.user) {
        const role =
          (data.user.app_metadata?.role as "admin" | "user") ?? "user";
        (req as AuthenticatedRequest).user = {
          id: data.user.id,
          email: data.user.email!,
          role,
        };
      }
    } catch {
      // Ignore — proceed as an anonymous request.
    }
  }
  next();
};

import { Request, Response, NextFunction } from 'express';
import { supabase } from '../lib/supabase';
import { AuthenticatedRequest } from '../types/user.types';

export const authenticateUser = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or malformed authorization header' });
    return;
  }

  const token = authHeader.split(' ')[1];

  try {
    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data.user) {
      res.status(401).json({ error: 'Invalid or expired token' });
      return;
    }

    const role = (data.user.app_metadata?.role as 'admin' | 'user') ?? 'user';

    (req as AuthenticatedRequest).user = {
      id: data.user.id,
      email: data.user.email!,
      role,
    };

    next();
  } catch {
    res.status(500).json({ error: 'Authentication service unavailable' });
  }
};

export const requireAdmin = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if ((req as AuthenticatedRequest).user?.role !== 'admin') {
    res.status(403).json({ error: 'Insufficient permissions' });
    return;
  }
  next();
};

export const requireSelf =
  (paramKey = 'id') =>
  (req: Request, res: Response, next: NextFunction): void => {
    const r = req as AuthenticatedRequest;
    if (r.user?.id !== req.params[paramKey] && r.user?.role !== 'admin') {
      res.status(403).json({ error: 'Access denied' });
      return;
    }
    next();
  };

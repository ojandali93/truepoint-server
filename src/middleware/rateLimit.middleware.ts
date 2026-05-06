import rateLimit from 'express-rate-limit';

const rateLimitMessage = (windowMs: number, max: number) => ({
  error: `Too many requests. Maximum ${max} requests per ${windowMs / 60000} minute(s).`,
});

export const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage(15 * 60 * 1000, 100),
});

export const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage(15 * 60 * 1000, 20),
});

export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage(15 * 60 * 1000, 50),
});

export const activityLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: rateLimitMessage(15 * 60 * 1000, 200),
});

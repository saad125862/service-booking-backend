import rateLimit from 'express-rate-limit';

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message } },
  });

// Per-user limit on the AI endpoint (each call costs money). Must run after requireAuth.
export const aiLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  keyGenerator: (req) => req.user?.id ?? 'anonymous',
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many messages, please slow down' } },
});

// Brute-force protection for credential endpoints.
export const authLimiter = make(15 * 60_000, 30, 'Too many attempts, please try again later');

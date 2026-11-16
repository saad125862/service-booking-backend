import rateLimit from 'express-rate-limit';

const make = (windowMs, limit, message) =>
  rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { success: false, error: { code: 'RATE_LIMITED', message } },
  });

// Brute-force protection for credential endpoints.
export const authLimiter = make(15 * 60_000, 30, 'Too many attempts, please try again later');

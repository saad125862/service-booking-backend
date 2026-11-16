import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { requireAuth } from './auth.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

const hasValidAdminKey = (req) => {
  const provided = req.get('x-admin-key');
  if (!provided) return false;
  // Hash first so the comparison is constant-time regardless of key length.
  return crypto.timingSafeEqual(sha(provided), sha(env.ADMIN_API_KEY));
};

// Role is read from the database on every request, so a demoted admin loses access
// immediately even if their token is still valid.
const checkAdminRole = async (req, _res, next) => {
  const user = await prisma.user.findUnique({ where: { id: req.user.id }, select: { role: true } });
  if (user?.role !== 'admin') throw ApiError.forbidden('Admin access required');
  next();
};

/** Requires a valid JWT belonging to an admin account. */
export const requireAdmin = [requireAuth, checkAdminRole];

/** Admin JWT, or the static ops key (X-Admin-Key). Used by the original status route. */
export const requireAdminOrKey = (req, res, next) => {
  if (hasValidAdminKey(req)) return next();
  return requireAuth(req, res, (err) => {
    if (err) return next(err);
    return Promise.resolve(checkAdminRole(req, res, next)).catch(next);
  });
};

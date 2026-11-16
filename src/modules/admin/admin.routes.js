import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';
import { adminSetStatus } from '../appointments/appointment.service.js';

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

// Static API key (header X-Admin-Key). Hashing first makes the comparison constant-time
// regardless of key length.
const requireAdminKey = (req, _res, next) => {
  const provided = req.get('x-admin-key') ?? '';
  if (!crypto.timingSafeEqual(sha(provided), sha(env.ADMIN_API_KEY))) {
    throw ApiError.forbidden('Invalid admin key');
  }
  next();
};

const router = Router();
router.use(requireAdminKey);

router.patch(
  '/appointments/:id/status',
  validate({
    params: z.object({ id: z.uuid() }),
    body: z.object({ status: z.enum(['confirmed', 'completed', 'cancelled']) }),
  }),
  async (req, res) => {
    ok(res, await adminSetStatus(req.valid.params.id, req.valid.body.status));
  },
);

export default router;

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { BCRYPT_COST } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { passwordField } from '../auth/auth.schema.js';
import { toUser } from './user.mapper.js';

const router = Router();
router.use(requireAuth);

const updateProfileBody = z
  .object({
    name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100).optional(),
    // null or empty string clears the phone number
    phone: z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{6,30}$/, 'Enter a valid phone number')
      .or(z.literal(''))
      .nullable()
      .optional(),
  })
  .refine((b) => b.name !== undefined || b.phone !== undefined, {
    message: 'Provide at least one field to update',
  });

const changePasswordBody = z.object({
  currentPassword: z.string().min(1, 'Current password is required').max(72),
  newPassword: passwordField,
});

async function findUser(id) {
  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) throw ApiError.unauthorized('Account no longer exists');
  return user;
}

router.get('/me', async (req, res) => {
  ok(res, toUser(await findUser(req.user.id)));
});

router.patch('/me', validate({ body: updateProfileBody }), async (req, res) => {
  const { name, phone } = req.valid.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (phone !== undefined) data.phone = phone || null;

  try {
    ok(res, toUser(await prisma.user.update({ where: { id: req.user.id }, data })));
  } catch (err) {
    if (err.code === 'P2025') throw ApiError.unauthorized('Account no longer exists'); // record not found
    throw err;
  }
});

router.patch('/me/password', authLimiter, validate({ body: changePasswordBody }), async (req, res) => {
  const { currentPassword, newPassword } = req.valid.body;
  const user = await findUser(req.user.id);

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    throw new ApiError(400, 'INVALID_CURRENT_PASSWORD', 'Current password is incorrect');
  }
  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, BCRYPT_COST) },
  });
  ok(res, { message: 'Password updated' });
});

export default router;

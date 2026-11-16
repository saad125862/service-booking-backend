import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { created, ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';
import { listPaymentMethods, toPaymentMethod } from '../payments/payment.service.js';

// Payment options admins offer to customers (cash, card, bKash, Nagad, bank, ...).

const router = Router();
const asAdmin = (m) => toPaymentMethod(m, { admin: true });

const text = (max) => z.string().trim().max(max).or(z.literal('')).nullable().optional();

// Rules without defaults, so a PATCH only changes what it sends (defaults apply on create only).
const fields = {
  name: z.string().trim().min(2).max(60),
  type: z.enum(['cash', 'card', 'mobile_wallet', 'bank']),
  instructions: text(500),
  accountNumber: text(40),
  requiresReference: z.boolean(),
  isActive: z.boolean(),
  sortOrder: z.coerce.number().int().min(0).max(1000),
};

const createBody = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{1,29}$/, 'Use lower-case letters, numbers and underscores'),
  ...fields,
  requiresReference: fields.requiresReference.default(false),
  isActive: fields.isActive.default(true),
  sortOrder: fields.sortOrder.default(0),
});

const updateBody = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

const idParams = z.object({ id: z.uuid() });
const clean = (v) => (v === '' ? null : v);

router.get('/', async (_req, res) => {
  ok(res, (await listPaymentMethods({ includeInactive: true })).map(asAdmin));
});

router.post('/', validate({ body: createBody }), async (req, res) => {
  const b = req.valid.body;
  try {
    const method = await prisma.paymentMethod.create({
      data: { ...b, instructions: clean(b.instructions), accountNumber: clean(b.accountNumber) },
    });
    created(res, asAdmin(method));
  } catch (err) {
    if (err?.code === 'P2002') throw ApiError.conflict('PAYMENT_CODE_TAKEN', 'A payment method with this code already exists');
    throw err;
  }
});

router.patch('/:id', validate({ params: idParams, body: updateBody }), async (req, res) => {
  const b = req.valid.body;
  const data = { ...b };
  if ('instructions' in b) data.instructions = clean(b.instructions);
  if ('accountNumber' in b) data.accountNumber = clean(b.accountNumber);
  try {
    ok(res, asAdmin(await prisma.paymentMethod.update({ where: { id: req.valid.params.id }, data })));
  } catch (err) {
    if (err?.code === 'P2025') throw ApiError.notFound('Payment method not found');
    throw err;
  }
});

// Deactivate instead of delete: existing bookings keep their payment method.
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  try {
    ok(res, asAdmin(await prisma.paymentMethod.update({ where: { id: req.valid.params.id }, data: { isActive: false } })));
  } catch (err) {
    if (err?.code === 'P2025') throw ApiError.notFound('Payment method not found');
    throw err;
  }
});

export default router;

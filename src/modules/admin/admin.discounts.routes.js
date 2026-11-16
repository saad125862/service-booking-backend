import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';
import {
  approveDiscountRequest,
  declineDiscountRequest,
  listDiscountRequestsForAdmin,
} from '../discounts/discount.service.js';

// Admin decisions on the discount requests customers make through the AI assistant.

const router = Router();
const idParams = z.object({ id: z.uuid() });
const note = z.string().trim().max(300).optional();

const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'declined', 'used']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const approveBody = z.object({
  type: z.enum(['percent', 'fixed']),
  value: z.coerce.number().positive('Enter an amount greater than 0').max(10_000_000),
  expiresInDays: z.coerce.number().int().min(1).max(90).default(14),
  note,
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await listDiscountRequestsForAdmin(req.valid.query);
  ok(res, items, meta);
});

router.patch('/:id/approve', validate({ params: idParams, body: approveBody }), async (req, res) => {
  ok(res, await approveDiscountRequest(req.valid.params.id, req.user.id, req.valid.body));
});

router.patch('/:id/decline', validate({ params: idParams, body: z.object({ note }) }), async (req, res) => {
  ok(res, await declineDiscountRequest(req.valid.params.id, req.user.id, req.valid.body));
});

export default router;

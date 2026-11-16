import { Router } from 'express';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { listPaymentMethods, toPaymentMethod } from './payment.service.js';

const router = Router();

// The payment options a customer can choose from when booking (active ones only).
router.get('/', requireAuth, async (_req, res) => {
  ok(res, (await listPaymentMethods()).map((m) => toPaymentMethod(m)));
});

export default router;

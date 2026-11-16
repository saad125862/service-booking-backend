import { Router } from 'express';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { listMyDiscountRequests } from './discount.service.js';

const router = Router();

// The signed-in customer's own discount requests and the assistant's answers. Requests are
// created through the AI chat (POST /ai/chat); an admin decides them.
router.get('/', requireAuth, async (req, res) => {
  ok(res, await listMyDiscountRequests(req.user.id));
});

export default router;

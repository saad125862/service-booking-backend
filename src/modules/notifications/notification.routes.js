import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as svc from './notification.service.js';

const router = Router();
router.use(requireAuth);

const listQuery = z.object({
  unread: z.enum(['true', 'false']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { unread, page, limit } = req.valid.query;
  const { items, meta } = await svc.listNotifications(req.user.id, { unreadOnly: unread === 'true', page, limit });
  ok(res, items, meta);
});

router.get('/unread-count', async (req, res) => {
  ok(res, { unreadCount: await svc.unreadCount(req.user.id) });
});

router.post('/read-all', async (req, res) => {
  ok(res, { updated: await svc.markAllRead(req.user.id) });
});

router.patch('/:id/read', validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  ok(res, await svc.markRead(req.user.id, req.valid.params.id));
});

export default router;

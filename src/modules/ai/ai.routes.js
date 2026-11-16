import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import { aiLimiter } from '../../middleware/rateLimit.js';
import * as aiService from './ai.service.js';

const chatBody = z.object({
  message: z.string().trim().min(1, 'Message is required').max(500, 'Message must be at most 500 characters'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant']),
        content: z.string().trim().min(1).max(1000),
      }),
    )
    .max(10, 'History can contain at most 10 messages')
    .default([]),
});

const router = Router();

// Auth first so the limiter can key on the user id; the Gemini key never leaves the server.
router.post('/chat', requireAuth, aiLimiter, validate({ body: chatBody }), async (req, res) => {
  ok(res, await aiService.chat(req.valid.body));
});

export default router;

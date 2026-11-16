import { Router } from 'express';
import { validate } from '../../middleware/validate.js';
import { authLimiter } from '../../middleware/rateLimit.js';
import { created, ok } from '../../utils/response.js';
import { loginBody, registerBody } from './auth.schema.js';
import * as authService from './auth.service.js';

const router = Router();
router.use(authLimiter);

router.post('/register', validate({ body: registerBody }), async (req, res) => {
  created(res, await authService.register(req.valid.body));
});

router.post('/login', validate({ body: loginBody }), async (req, res) => {
  ok(res, await authService.login(req.valid.body));
});

export default router;

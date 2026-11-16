import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import { env } from './config/env.js';
import { prisma } from './db/prisma.js';
import { ok } from './utils/response.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import authRoutes from './modules/auth/auth.routes.js';
import userRoutes from './modules/users/user.routes.js';
import serviceRoutes from './modules/services/service.routes.js';
import { appointmentRoutes, availabilityRoutes } from './modules/appointments/appointment.routes.js';
import adminRoutes from './modules/admin/admin.routes.js';

export function createApp() {
  const app = express();

  // Render (and most hosts) sit behind a proxy; needed for correct client IPs in rate limiting.
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS === '*' ? true : env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    }),
  );
  app.use(express.json({ limit: '100kb' }));
  if (env.NODE_ENV !== 'test') app.use(morgan(env.NODE_ENV === 'production' ? 'combined' : 'dev'));

  // Global limiter; stricter per-route limiters are added on auth and AI routes.
  app.use(
    rateLimit({
      windowMs: 60_000,
      limit: 300,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } },
    }),
  );

  const api = express.Router();

  api.get('/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    ok(res, { status: 'ok', uptime: Math.round(process.uptime()) });
  });

  api.use('/auth', authRoutes);
  api.use('/users', userRoutes);
  api.use('/services', serviceRoutes);
  api.use('/services', availabilityRoutes);
  api.use('/appointments', appointmentRoutes);
  api.use('/admin', adminRoutes);

  app.use('/api/v1', api);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

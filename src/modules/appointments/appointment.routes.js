import { Router } from 'express';
import { z } from 'zod';
import { created, ok } from '../../utils/response.js';
import { requireAuth } from '../../middleware/auth.js';
import { validate } from '../../middleware/validate.js';
import * as svc from './appointment.service.js';

const idParams = z.object({ id: z.uuid() });

const createBody = z.object({
  serviceId: z.uuid(),
  startTime: z.iso.datetime({ offset: true, message: 'startTime must be an ISO 8601 date-time' }),
  notes: z.string().trim().max(500).optional(),
});

const listQuery = z.object({
  scope: z.enum(['upcoming', 'past']).optional(),
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const appointmentRoutes = Router();
appointmentRoutes.use(requireAuth);

appointmentRoutes.post('/', validate({ body: createBody }), async (req, res) => {
  created(res, await svc.createAppointment(req.user.id, req.valid.body));
});

appointmentRoutes.get('/', validate({ query: listQuery }), async (req, res) => {
  const { items, meta } = await svc.listAppointments(req.user.id, req.valid.query);
  ok(res, items, meta);
});

appointmentRoutes.get('/:id', validate({ params: idParams }), async (req, res) => {
  ok(res, await svc.getAppointment(req.user.id, req.valid.params.id));
});

appointmentRoutes.patch('/:id/cancel', validate({ params: idParams }), async (req, res) => {
  ok(res, await svc.cancelAppointment(req.user.id, req.valid.params.id));
});

// GET /services/:id/availability?date=YYYY-MM-DD (mounted under /services)
const availabilityQuery = z.object({
  date: z.iso.date('date must be YYYY-MM-DD'),
});

export const availabilityRoutes = Router();
availabilityRoutes.get(
  '/:id/availability',
  requireAuth,
  validate({ params: idParams, query: availabilityQuery }),
  async (req, res) => {
    ok(res, await svc.getAvailability(req.valid.params.id, req.valid.query.date));
  },
);

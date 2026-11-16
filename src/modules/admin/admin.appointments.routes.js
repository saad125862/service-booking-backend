import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { addDays, zonedToUtcMs } from '../../utils/time.js';
import { validate } from '../../middleware/validate.js';
import { notify } from '../notifications/notification.service.js';
import { toAppointment } from '../appointments/appointment.service.js';

// All bookings for admins: filter, and verify payments. (Status changes live in admin.routes.js.)

const router = Router();

const include = {
  service: true,
  paymentMethod: true,
  user: { select: { id: true, name: true, email: true, phone: true } },
};

export const toAdminAppointment = (a) => ({
  ...toAppointment(a),
  customer: a.user ? { id: a.user.id, name: a.user.name, email: a.user.email, phone: a.user.phone } : null,
});

const date = z.iso.date('Use YYYY-MM-DD');

const listQuery = z.object({
  status: z.enum(['pending', 'confirmed', 'cancelled', 'completed']).optional(),
  paymentStatus: z.enum(['unpaid', 'submitted', 'paid', 'failed']).optional(),
  search: z.string().trim().max(100).optional(),
  from: date.optional(),
  to: date.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { status, paymentStatus, search, from, to, page, limit } = req.valid.query;
  const tz = env.BUSINESS_TZ;
  const where = {
    ...(status && { status }),
    ...(paymentStatus && { paymentStatus }),
    ...((from || to) && {
      startTime: {
        ...(from && { gte: new Date(zonedToUtcMs(from, 0, 0, tz)) }),
        ...(to && { lt: new Date(zonedToUtcMs(addDays(to, 1), 0, 0, tz)) }),
      },
    }),
    ...(search && {
      OR: [
        { user: { name: { contains: search, mode: 'insensitive' } } },
        { user: { email: { contains: search, mode: 'insensitive' } } },
        { service: { name: { contains: search, mode: 'insensitive' } } },
      ],
    }),
  };

  const [total, rows] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      include,
      orderBy: { startTime: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  ok(res, rows.map(toAdminAppointment), { page, limit, total, totalPages: Math.ceil(total / limit) });
});

router.get('/:id', validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  const row = await prisma.appointment.findUnique({ where: { id: req.valid.params.id }, include });
  if (!row) throw ApiError.notFound('Appointment not found');
  ok(res, toAdminAppointment(row));
});

// Verify (or reject) the customer's payment, e.g. after checking a bKash transaction ID.
router.patch(
  '/:id/payment',
  validate({
    params: z.object({ id: z.uuid() }),
    body: z.object({ status: z.enum(['paid', 'failed', 'unpaid']) }),
  }),
  async (req, res) => {
    const { id } = req.valid.params;
    const { status } = req.valid.body;

    const existing = await prisma.appointment.findUnique({ where: { id }, include });
    if (!existing) throw ApiError.notFound('Appointment not found');
    if (existing.status === 'cancelled') {
      throw ApiError.conflict('INVALID_STATE', 'The payment of a cancelled booking cannot be changed');
    }

    const row = await prisma.appointment.update({
      where: { id },
      data: { paymentStatus: status, paidAt: status === 'paid' ? new Date() : null },
      include,
    });

    if (status !== existing.paymentStatus && (status === 'paid' || status === 'failed')) {
      const label = `${row.service.name} (${row.paymentMethod?.name ?? 'payment'})`;
      await notify(row.userId, {
        type: status === 'paid' ? 'payment_verified' : 'payment_failed',
        title: status === 'paid' ? 'Payment received' : 'Payment could not be verified',
        body:
          status === 'paid'
            ? `We received your payment for ${label}. Thank you!`
            : `We could not verify your payment for ${label}. Please contact us or choose another payment method.`,
        data: { appointmentId: id },
      });
    }
    ok(res, toAdminAppointment(row));
  },
);

export default router;

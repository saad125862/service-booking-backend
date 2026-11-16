import { Router } from 'express';
import { z } from 'zod';
import { ok } from '../../utils/response.js';
import { requireAdmin, requireAdminOrKey } from '../../middleware/admin.js';
import { validate } from '../../middleware/validate.js';
import { adminSetStatus } from '../appointments/appointment.service.js';
import appointmentRoutes from './admin.appointments.routes.js';
import discountRoutes from './admin.discounts.routes.js';
import fieldRoutes from './admin.fields.routes.js';
import paymentRoutes from './admin.payments.routes.js';
import reportRoutes from './admin.reports.js';
import serviceRoutes from './admin.services.routes.js';
import { uploadRoutes } from '../media/media.routes.js';

const router = Router();

// Move a booking through its lifecycle. Accepts an admin's JWT, or the static ops key
// (X-Admin-Key) used for scripted demos.
router.patch(
  '/appointments/:id/status',
  requireAdminOrKey,
  validate({
    params: z.object({ id: z.uuid() }),
    body: z.object({ status: z.enum(['confirmed', 'completed', 'cancelled']) }),
  }),
  async (req, res) => {
    ok(res, await adminSetStatus(req.valid.params.id, req.valid.body.status));
  },
);

// Everything below needs an admin account (role checked on every request).
router.use(requireAdmin);
router.use('/uploads', uploadRoutes);
router.use('/services', serviceRoutes);
router.use('/service-fields', fieldRoutes);
router.use('/payment-methods', paymentRoutes);
router.use('/appointments', appointmentRoutes);
router.use('/discount-requests', discountRoutes);
router.use('/', reportRoutes);

export default router;

import { prisma, exclusionViolation } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { APPOINTMENT_STATUS as STATUS, BOOKING } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { formatDateTime, localDateString, zonedToUtcMs } from '../../utils/time.js';
import { bookableDateRange, generateSlots } from './slots.js';
import { notify, notifyAdmins } from '../notifications/notification.service.js';
import { canPayOnline } from '../gateway/gateway.service.js';
import { findApplicableDiscount, restoreDiscountForAppointment } from '../discounts/discount.service.js';

const ACTIVE = [STATUS.PENDING, STATUS.CONFIRMED];
const withService = { service: true, paymentMethod: true };

export const toAppointment = (a) => ({
  id: a.id,
  status: a.status,
  startTime: a.startTime,
  endTime: a.endTime,
  startLabel: formatDateTime(a.startTime.getTime(), env.BUSINESS_TZ),
  timeZone: env.BUSINESS_TZ,
  address: a.address,
  notes: a.notes,
  createdAt: a.createdAt,
  // Price snapshot taken when the booking was made (list price, discount, amount to pay).
  price: Number(a.price),
  originalPrice: Number(a.originalPrice),
  discountAmount: Number(a.discountAmount),
  paymentStatus: a.paymentStatus,
  paymentReference: a.paymentReference,
  paidAt: a.paidAt,
  // True while an online payment link can still be created for this booking.
  canPayOnline: canPayOnline(a),
  paymentMethod: a.paymentMethod
    ? {
        id: a.paymentMethod.id,
        code: a.paymentMethod.code,
        name: a.paymentMethod.name,
        type: a.paymentMethod.type,
        online: Boolean(a.paymentMethod.gatewayProvider),
      }
    : null,
  service: {
    id: a.service.id,
    name: a.service.name,
    price: Number(a.service.price),
    durationMinutes: a.service.durationMinutes,
    imageUrl: a.service.imageUrl,
    category: a.service.category,
  },
});

async function getActiveService(serviceId) {
  const service = await prisma.service.findFirst({ where: { id: serviceId, isActive: true } });
  if (!service) throw ApiError.notFound('Service not found');
  return service;
}

async function bookedRanges(serviceId, dayStartMs, dayEndMs) {
  const rows = await prisma.appointment.findMany({
    where: {
      serviceId,
      status: { in: ACTIVE },
      startTime: { lt: new Date(dayEndMs) },
      endTime: { gt: new Date(dayStartMs) },
    },
    select: { startTime: true, endTime: true },
  });
  return rows.map((r) => ({ start: r.startTime.getTime(), end: r.endTime.getTime() }));
}

export async function getAvailability(serviceId, date) {
  const tz = env.BUSINESS_TZ;
  const nowMs = Date.now();
  const { first, last } = bookableDateRange(nowMs, tz);
  if (date < first || date > last) {
    throw ApiError.validation(
      [{ field: 'date', message: `Date must be between ${first} and ${last}` }],
      'Date is outside the bookable range',
    );
  }

  const service = await getActiveService(serviceId);
  const dayStart = zonedToUtcMs(date, BOOKING.WORK_START_HOUR, 0, tz);
  const dayEnd = zonedToUtcMs(date, BOOKING.WORK_END_HOUR, 0, tz);
  const booked = await bookedRanges(serviceId, dayStart, dayEnd);

  return {
    date,
    timeZone: tz,
    serviceId,
    durationMinutes: service.durationMinutes,
    slots: generateSlots({ date, durationMinutes: service.durationMinutes, tz, booked, nowMs }),
  };
}

export async function createAppointment(userId, { serviceId, startTime, address, notes, paymentMethodId, paymentReference }) {
  const tz = env.BUSINESS_TZ;
  const service = await getActiveService(serviceId);
  const startMs = new Date(startTime).getTime();
  const nowMs = Date.now();

  // The requested start must be one of the generated, currently-available slots for its day.
  const date = localDateString(startMs, tz);
  const { first, last } = bookableDateRange(nowMs, tz);
  const dayStart = zonedToUtcMs(date, BOOKING.WORK_START_HOUR, 0, tz);
  const dayEnd = zonedToUtcMs(date, BOOKING.WORK_END_HOUR, 0, tz);
  const slots =
    date < first || date > last
      ? []
      : generateSlots({
          date,
          durationMinutes: service.durationMinutes,
          tz,
          booked: await bookedRanges(serviceId, dayStart, dayEnd),
          nowMs,
        });
  const slot = slots.find((s) => new Date(s.start).getTime() === startMs);

  if (!slot) {
    throw new ApiError(400, 'INVALID_SLOT', 'That time is not a valid bookable slot for this service');
  }
  if (!slot.available) {
    throw ApiError.conflict('SLOT_UNAVAILABLE', 'That time slot is no longer available');
  }

  // The chosen payment option must be one an admin has enabled; wallet-style options need
  // the customer's transaction reference so an admin can verify the payment later.
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, isActive: true } });
  if (!method) throw new ApiError(400, 'INVALID_PAYMENT_METHOD', 'Choose one of the available payment methods');
  const reference = paymentReference?.trim() || null;
  if (method.requiresReference && (!reference || reference.length < 4)) {
    throw ApiError.validation([{ field: 'paymentReference', message: `Enter the ${method.name} transaction ID` }]);
  }

  try {
    // One transaction: apply this customer's approved discount (if any), create the booking and
    // consume the discount, so a discount can only ever be used by a single order.
    const created = await prisma.$transaction(async (tx) => {
      const discount = await findApplicableDiscount(tx, userId, serviceId, service.price);
      const originalPrice = Number(service.price);
      const discountAmount = discount ? discount.amount : 0;

      const row = await tx.appointment.create({
        data: {
          userId,
          serviceId,
          startTime: new Date(slot.start),
          endTime: new Date(slot.end),
          address,
          notes: notes ?? null,
          originalPrice,
          discountAmount,
          price: originalPrice - discountAmount,
          paymentMethodId: method.id,
          paymentStatus: method.requiresReference ? 'submitted' : 'unpaid',
          paymentReference: method.requiresReference ? reference : null,
        },
        include: withService,
      });
      if (discount) {
        await tx.discountRequest.update({
          where: { id: discount.request.id },
          data: { status: 'used', usedAppointmentId: row.id },
        });
      }
      return row;
    });
    const appointment = toAppointment(created);
    await announceNewBooking(userId, appointment);
    return appointment;
  } catch (err) {
    // The database's exclusion constraint caught a conflicting booking (e.g. a race between requests).
    const violation = exclusionViolation(err);
    if (violation === 'user') {
      throw ApiError.conflict('USER_OVERLAP', 'You already have a booking that overlaps this time');
    }
    if (violation === 'service') {
      throw ApiError.conflict('SLOT_UNAVAILABLE', 'That time slot was just taken, please pick another');
    }
    throw err;
  }
}

async function announceNewBooking(userId, appointment) {
  const customer = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  const data = { appointmentId: appointment.id };
  const label = `${appointment.service.name} on ${appointment.startLabel}`;
  await notify(userId, {
    type: 'booking_created',
    title: 'Booking requested',
    body: `Your ${label} is pending confirmation.`,
    data,
  });
  await notifyAdmins({
    type: 'booking_new',
    title: 'New booking',
    body: `${customer?.name ?? 'A customer'} booked ${label}.`,
    data,
  });
}

// What the customer is told when an admin (or the system) changes a booking's status.
const STATUS_MESSAGES = {
  [STATUS.CONFIRMED]: ['booking_confirmed', 'Booking confirmed', (l) => `Good news! Your ${l} is confirmed.`],
  [STATUS.COMPLETED]: ['booking_completed', 'Booking completed', (l) => `Your ${l} is complete. Thank you for choosing Seba!`],
  [STATUS.CANCELLED]: ['booking_cancelled', 'Booking cancelled', (l) => `Your ${l} was cancelled by the provider.`],
};

export async function announceStatusChange(appointment, newStatus) {
  const entry = STATUS_MESSAGES[newStatus];
  if (!entry) return;
  const [type, title, body] = entry;
  await notify(appointment.userId, {
    type,
    title,
    body: body(`${appointment.service.name} on ${formatDateTime(appointment.startTime.getTime(), env.BUSINESS_TZ)}`),
    data: { appointmentId: appointment.id },
  });
}

export async function listAppointments(userId, { scope, status, page, limit }) {
  // upcoming: still ahead and active; past: everything else (ended, cancelled, completed)
  const upcoming = { endTime: { gt: new Date() }, status: { in: ACTIVE } };
  const where = {
    userId,
    ...(status && { status }),
    ...(scope === 'upcoming' && upcoming),
    ...(scope === 'past' && { NOT: upcoming }),
  };

  const [total, rows] = await Promise.all([
    prisma.appointment.count({ where }),
    prisma.appointment.findMany({
      where,
      orderBy: { startTime: scope === 'upcoming' ? 'asc' : 'desc' },
      skip: (page - 1) * limit,
      take: limit,
      include: withService,
    }),
  ]);
  return { items: rows.map(toAppointment), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Scoped to the owner: someone else's appointment is indistinguishable from a missing one.
export async function getAppointment(userId, id) {
  const row = await prisma.appointment.findFirst({ where: { id, userId }, include: withService });
  if (!row) throw ApiError.notFound('Appointment not found');
  return toAppointment(row);
}

export async function cancelAppointment(userId, id) {
  // Single atomic statement: ownership and "pending only" are enforced together.
  const { count } = await prisma.appointment.updateMany({
    where: { id, userId, status: STATUS.PENDING },
    data: { status: STATUS.CANCELLED },
  });
  if (count === 0) {
    const existing = await getAppointment(userId, id); // throws 404 if missing / not owned
    throw ApiError.conflict(
      'NOT_CANCELLABLE',
      `Only pending appointments can be cancelled (this one is ${existing.status})`,
    );
  }
  await restoreDiscountForAppointment(prisma, id);
  const cancelled = await getAppointment(userId, id);
  const customer = await prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
  await notifyAdmins({
    type: 'booking_cancelled',
    title: 'Booking cancelled',
    body: `${customer?.name ?? 'A customer'} cancelled ${cancelled.service.name} on ${cancelled.startLabel}.`,
    data: { appointmentId: id },
  });
  return cancelled;
}

// Which current statuses may move to each target status.
const ALLOWED_FROM = {
  [STATUS.CONFIRMED]: [STATUS.PENDING],
  [STATUS.COMPLETED]: [STATUS.CONFIRMED],
  [STATUS.CANCELLED]: [STATUS.PENDING, STATUS.CONFIRMED],
};

// Operations/demo path: moves a booking forward through its lifecycle (atomic conditional update).
export async function adminSetStatus(id, newStatus) {
  const { count } = await prisma.appointment.updateMany({
    where: { id, status: { in: ALLOWED_FROM[newStatus] } },
    data: { status: newStatus },
  });
  const row = await prisma.appointment.findUnique({ where: { id }, include: withService });
  if (!row) throw ApiError.notFound('Appointment not found');
  if (count === 0) {
    throw ApiError.conflict('INVALID_TRANSITION', `Cannot change status from ${row.status} to ${newStatus}`);
  }
  if (newStatus === STATUS.CANCELLED) await restoreDiscountForAppointment(prisma, id);
  await announceStatusChange(row, newStatus);
  return toAppointment(row);
}

// Confirmed bookings whose time has passed become completed.
export async function completePastAppointments() {
  const due = await prisma.appointment.findMany({
    where: { status: STATUS.CONFIRMED, endTime: { lt: new Date() } },
    include: withService,
  });
  if (due.length === 0) return 0;
  const { count } = await prisma.appointment.updateMany({
    where: { id: { in: due.map((a) => a.id) }, status: STATUS.CONFIRMED },
    data: { status: STATUS.COMPLETED },
  });
  for (const appointment of due) await announceStatusChange(appointment, STATUS.COMPLETED);
  return count;
}

import { prisma, exclusionViolation } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { APPOINTMENT_STATUS as STATUS, BOOKING } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { formatDateTime, localDateString, zonedToUtcMs } from '../../utils/time.js';
import { bookableDateRange, generateSlots } from './slots.js';

const ACTIVE = [STATUS.PENDING, STATUS.CONFIRMED];
const withService = { service: true };

export const toAppointment = (a) => ({
  id: a.id,
  status: a.status,
  startTime: a.startTime,
  endTime: a.endTime,
  startLabel: formatDateTime(a.startTime.getTime(), env.BUSINESS_TZ),
  timeZone: env.BUSINESS_TZ,
  notes: a.notes,
  createdAt: a.createdAt,
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

export async function createAppointment(userId, { serviceId, startTime, notes }) {
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

  try {
    const created = await prisma.appointment.create({
      data: {
        userId,
        serviceId,
        startTime: new Date(slot.start),
        endTime: new Date(slot.end),
        notes: notes ?? null,
      },
      include: withService,
    });
    return toAppointment(created);
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
  return getAppointment(userId, id);
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
  return toAppointment(row);
}

// Confirmed bookings whose time has passed become completed.
export async function completePastAppointments() {
  const { count } = await prisma.appointment.updateMany({
    where: { status: STATUS.CONFIRMED, endTime: { lt: new Date() } },
    data: { status: STATUS.COMPLETED },
  });
  return count;
}

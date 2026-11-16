import { pool, query } from '../../db/pool.js';
import { env } from '../../config/env.js';
import { APPOINTMENT_STATUS as STATUS, BOOKING } from '../../config/constants.js';
import { ApiError } from '../../utils/ApiError.js';
import { formatDateTime, localDateString, zonedToUtcMs } from '../../utils/time.js';
import { bookableDateRange, generateSlots } from './slots.js';

const SELECT = `
  SELECT a.*, s.name AS service_name, s.price AS service_price, s.duration_minutes AS service_duration,
         s.image_url AS service_image, s.category AS service_category
    FROM appointments a
    JOIN services s ON s.id = a.service_id`;

export const toAppointment = (r) => ({
  id: r.id,
  status: r.status,
  startTime: r.start_time,
  endTime: r.end_time,
  startLabel: formatDateTime(new Date(r.start_time).getTime(), env.BUSINESS_TZ),
  timeZone: env.BUSINESS_TZ,
  notes: r.notes,
  createdAt: r.created_at,
  service: {
    id: r.service_id,
    name: r.service_name,
    price: Number(r.service_price),
    durationMinutes: r.service_duration,
    imageUrl: r.service_image,
    category: r.service_category,
  },
});

async function getActiveService(serviceId) {
  const { rows } = await query(`SELECT * FROM services WHERE id = $1 AND is_active`, [serviceId]);
  if (!rows[0]) throw ApiError.notFound('Service not found');
  return rows[0];
}

async function bookedRanges(serviceId, dayStartMs, dayEndMs) {
  const { rows } = await query(
    `SELECT start_time, end_time FROM appointments
      WHERE service_id = $1 AND status IN ('pending', 'confirmed')
        AND start_time < $3 AND end_time > $2`,
    [serviceId, new Date(dayStartMs), new Date(dayEndMs)],
  );
  return rows.map((r) => ({ start: r.start_time.getTime(), end: r.end_time.getTime() }));
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
    durationMinutes: service.duration_minutes,
    slots: generateSlots({ date, durationMinutes: service.duration_minutes, tz, booked, nowMs }),
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
          durationMinutes: service.duration_minutes,
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
    const { rows } = await query(
      `INSERT INTO appointments (user_id, service_id, start_time, end_time, notes)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [userId, serviceId, new Date(slot.start), new Date(slot.end), notes ?? null],
    );
    return getAppointment(userId, rows[0].id);
  } catch (err) {
    // 23P01 = exclusion_violation: the database caught a conflicting booking (e.g. a race).
    if (err.code === '23P01') {
      if (err.constraint === 'appointments_no_user_overlap') {
        throw ApiError.conflict('USER_OVERLAP', 'You already have a booking that overlaps this time');
      }
      throw ApiError.conflict('SLOT_UNAVAILABLE', 'That time slot was just taken, please pick another');
    }
    throw err;
  }
}

export async function listAppointments(userId, { scope, status, page, limit }) {
  const where = ['a.user_id = $1'];
  const params = [userId];
  if (status) {
    params.push(status);
    where.push(`a.status = $${params.length}`);
  }
  // upcoming: still ahead and active; past: everything else (ended, cancelled, completed)
  const upcoming = `(a.end_time > now() AND a.status IN ('pending', 'confirmed'))`;
  if (scope === 'upcoming') where.push(upcoming);
  if (scope === 'past') where.push(`NOT ${upcoming}`);

  const order = scope === 'upcoming' ? 'a.start_time ASC' : 'a.start_time DESC';
  const whereSql = where.join(' AND ');

  const total = Number(
    (await query(`SELECT count(*) FROM appointments a WHERE ${whereSql}`, params)).rows[0].count,
  );
  const { rows } = await query(
    `${SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  );
  return { items: rows.map(toAppointment), meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}

// Scoped to the owner: someone else's appointment is indistinguishable from a missing one.
export async function getAppointment(userId, id) {
  const { rows } = await query(`${SELECT} WHERE a.id = $1 AND a.user_id = $2`, [id, userId]);
  if (!rows[0]) throw ApiError.notFound('Appointment not found');
  return toAppointment(rows[0]);
}

export async function cancelAppointment(userId, id) {
  // Single atomic statement: ownership and "pending only" are enforced together.
  const { rowCount } = await query(
    `UPDATE appointments SET status = $3 WHERE id = $1 AND user_id = $2 AND status = $4`,
    [id, userId, STATUS.CANCELLED, STATUS.PENDING],
  );
  if (rowCount === 0) {
    const existing = await getAppointment(userId, id); // throws 404 if missing / not owned
    throw ApiError.conflict(
      'NOT_CANCELLABLE',
      `Only pending appointments can be cancelled (this one is ${existing.status})`,
    );
  }
  return getAppointment(userId, id);
}

const TRANSITIONS = {
  [STATUS.PENDING]: [STATUS.CONFIRMED, STATUS.CANCELLED],
  [STATUS.CONFIRMED]: [STATUS.COMPLETED, STATUS.CANCELLED],
};

// Operations/demo path: moves a booking forward through its lifecycle.
export async function adminSetStatus(id, newStatus) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(`SELECT status FROM appointments WHERE id = $1 FOR UPDATE`, [id]);
    if (!rows[0]) throw ApiError.notFound('Appointment not found');
    if (!(TRANSITIONS[rows[0].status] ?? []).includes(newStatus)) {
      throw ApiError.conflict('INVALID_TRANSITION', `Cannot change status from ${rows[0].status} to ${newStatus}`);
    }
    await client.query(`UPDATE appointments SET status = $2 WHERE id = $1`, [id, newStatus]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  const { rows } = await query(`${SELECT} WHERE a.id = $1`, [id]);
  return toAppointment(rows[0]);
}

// Confirmed bookings whose time has passed become completed.
export async function completePastAppointments() {
  const { rowCount } = await query(
    `UPDATE appointments SET status = 'completed' WHERE status = 'confirmed' AND end_time < now()`,
  );
  return rowCount;
}

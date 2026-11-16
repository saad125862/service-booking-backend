import { BOOKING } from '../../config/constants.js';
import { addDays, formatTime, localDateString, zonedToUtcMs } from '../../utils/time.js';

const MIN = 60_000;

// Returns the valid date range (inclusive, as YYYY-MM-DD in tz) that can be booked.
export function bookableDateRange(nowMs, tz) {
  const today = localDateString(nowMs, tz);
  return { first: today, last: addDays(today, BOOKING.MAX_DAYS_AHEAD) };
}

/**
 * Builds the slot grid for one local day.
 * A slot is `available` when it fits inside working hours, respects the minimum lead time,
 * and does not overlap an active booking in `booked` ([{ start: ms, end: ms }]).
 * This is advisory for the UI; the database exclusion constraint is the source of truth.
 */
export function generateSlots({ date, durationMinutes, tz, booked, nowMs }) {
  const dayStart = zonedToUtcMs(date, BOOKING.WORK_START_HOUR, 0, tz);
  const dayEnd = zonedToUtcMs(date, BOOKING.WORK_END_HOUR, 0, tz);
  const earliest = nowMs + BOOKING.MIN_LEAD_MINUTES * MIN;
  const duration = durationMinutes * MIN;
  const step = BOOKING.SLOT_STEP_MINUTES * MIN;

  const slots = [];
  for (let start = dayStart; start + duration <= dayEnd; start += step) {
    const end = start + duration;
    const taken = booked.some((b) => start < b.end && end > b.start);
    slots.push({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      label: formatTime(start, tz),
      available: !taken && start >= earliest,
    });
  }
  return slots;
}

// Booking rules. Adjust here; nothing else hard-codes these values.
export const BOOKING = {
  WORK_START_HOUR: 9, // 09:00 in BUSINESS_TZ
  WORK_END_HOUR: 17, // 17:00 in BUSINESS_TZ
  SLOT_STEP_MINUTES: 30,
  MIN_LEAD_MINUTES: 60,
  MAX_DAYS_AHEAD: 60,
};

export const APPOINTMENT_STATUS = {
  PENDING: 'pending',
  CONFIRMED: 'confirmed',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
};

export const BCRYPT_COST = 12;

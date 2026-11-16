import { completePastAppointments } from '../modules/appointments/appointment.service.js';

// Marks confirmed appointments as completed once their end time has passed.
export function startCompletionJob(intervalMs = 60_000) {
  const run = async () => {
    try {
      const n = await completePastAppointments();
      if (n > 0) console.log(`Completed ${n} past appointment(s)`);
    } catch (err) {
      console.error('Completion job failed:', err.message);
    }
  };
  run();
  return setInterval(run, intervalMs).unref();
}

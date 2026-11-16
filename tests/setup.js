import 'dotenv/config';
import { afterAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.BUSINESS_TZ = 'UTC'; // tests express slot times in UTC regardless of the configured zone
process.env.GEMINI_API_KEY = ''; // tests never call Gemini

afterAll(async () => {
  const { prisma } = await import('../src/db/prisma.js');
  // Notifications sent to the demo admin about test bookings (their text starts with the test user's name).
  await prisma.notification.deleteMany({ where: { body: { startsWith: 'Test ' } } });
  // Appointments and the test users' own notifications are removed by ON DELETE CASCADE.
  await prisma.user.deleteMany({ where: { email: { startsWith: 'test-' } } });
  await prisma.$disconnect();
});

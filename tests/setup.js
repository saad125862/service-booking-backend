import 'dotenv/config';
import { afterAll } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.BUSINESS_TZ = 'UTC'; // tests express slot times in UTC regardless of the configured zone
process.env.GEMINI_API_KEY = ''; // tests never call Gemini

afterAll(async () => {
  const { prisma } = await import('../src/db/prisma.js');
  // Appointments are removed by the ON DELETE CASCADE on users.
  await prisma.user.deleteMany({ where: { email: { startsWith: 'test-' } } });
  await prisma.$disconnect();
});

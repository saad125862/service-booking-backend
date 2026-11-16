import pkg from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { env } from '../config/env.js';

// @prisma/client is CommonJS, so pull the named exports off the default export.
const { PrismaClient, Prisma } = pkg;

const adapter = new PrismaPg({
  connectionString: env.DATABASE_URL,
  ssl: env.DATABASE_SSL ? { rejectUnauthorized: true } : undefined,
  max: 10,
  connectionTimeoutMillis: 10_000,
});

export const prisma = new PrismaClient({ adapter });
export { Prisma };

// PostgreSQL error code for exclusion-constraint violations (overlapping bookings).
// Prisma doesn't map it to a P-code, so inspect the underlying driver error / message.
export function exclusionViolation(err) {
  const text = `${err?.message ?? ''} ${JSON.stringify(err?.meta ?? {})}`;
  const isExclusion = text.includes('23P01') || /exclusion constraint/i.test(text);
  if (!isExclusion) return null;
  return text.includes('appointments_no_user_overlap') ? 'user' : 'service';
}

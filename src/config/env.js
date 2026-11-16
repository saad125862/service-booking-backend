import { z } from 'zod';
import { isValidTimeZone } from '../utils/time.js';

// Validate configuration once at boot so a bad deployment fails fast and loudly.
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  DATABASE_SSL: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  GEMINI_API_KEY: z.string().default(''),
  // Primary model, plus a fallback tried once on overload/rate-limit/timeout.
  GEMINI_MODEL: z.string().default('gemini-3.5-flash-lite'),
  GEMINI_FALLBACK_MODEL: z.string().default('gemini-3.1-flash-lite'),
  ADMIN_API_KEY: z.string().min(16, 'ADMIN_API_KEY must be at least 16 characters'),
  BUSINESS_TZ: z
    .string()
    .default('UTC')
    .refine(isValidTimeZone, 'BUSINESS_TZ must be a valid IANA time zone, e.g. Asia/Dhaka'),
  CORS_ORIGINS: z.string().default('*'),

  // Online card / wallet payments. A provider is offered to customers only when it is configured.
  // PUBLIC_API_URL is where the gateways send the customer back (must be reachable from the browser).
  PUBLIC_API_URL: z.string().default('http://localhost:3000'),
  SSLCOMMERZ_STORE_ID: z.string().default(''),
  SSLCOMMERZ_STORE_PASSWORD: z.string().default(''),
  SSLCOMMERZ_SANDBOX: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  AAMARPAY_STORE_ID: z.string().default(''),
  AAMARPAY_SIGNATURE_KEY: z.string().default(''),
  AAMARPAY_SANDBOX: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
  // A built-in fake checkout page for demos and tests. On by default outside production.
  GATEWAY_MOCK_ENABLED: z.enum(['true', 'false']).optional().transform((v) => (v === undefined ? undefined : v === 'true')),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = {
  ...parsed.data,
  GATEWAY_MOCK_ENABLED: parsed.data.GATEWAY_MOCK_ENABLED ?? parsed.data.NODE_ENV !== 'production',
};
export const isProd = env.NODE_ENV === 'production';

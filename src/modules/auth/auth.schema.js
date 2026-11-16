import { z } from 'zod';

export const emailField = z.string().trim().toLowerCase().pipe(z.email('Enter a valid email address'));

// bcrypt only uses the first 72 bytes, so cap there.
export const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(72, 'Password must be at most 72 characters')
  .regex(/[A-Za-z]/, 'Password must contain a letter')
  .regex(/\d/, 'Password must contain a number');

export const registerBody = z.object({
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(100),
  email: emailField,
  password: passwordField,
});

export const loginBody = z.object({
  email: emailField,
  password: z.string().min(1, 'Password is required').max(72),
});

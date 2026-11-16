import request from 'supertest';
import { createApp } from '../src/app.js';

export const app = createApp();
export const api = () => request(app);
export const ADMIN_KEY = process.env.ADMIN_API_KEY;
export const ADDRESS = 'House 12, Road 5, Dhanmondi, Dhaka';

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

// Creates a throwaway user (emails start with "test-" so setup.js can clean them up).
export async function registerUser(tag = 'user') {
  const email = `test-${tag}-${unique()}@example.com`;
  const res = await api()
    .post('/api/v1/auth/register')
    .send({ name: `Test ${tag}`, email, password: 'Passw0rd1' });
  return { email, token: res.body.data.token, id: res.body.data.user.id };
}

export const auth = (token) => ({ Authorization: `Bearer ${token}` });

export async function findService(name) {
  const res = await api().get('/api/v1/services').query({ search: name, limit: 50 });
  return res.body.data.find((s) => s.name === name);
}

// A date `days` from now as YYYY-MM-DD (UTC, matching BUSINESS_TZ=UTC in tests).
export const dateIn = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
export const at = (date, hhmm) => `${date}T${hhmm}:00.000Z`;

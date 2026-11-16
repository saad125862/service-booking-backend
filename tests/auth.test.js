import { describe, expect, it } from 'vitest';
import { api, auth, registerUser } from './helpers.js';

describe('auth and profile', () => {
  it('registers, rejects duplicate emails (case-insensitive) and hides the password hash', async () => {
    const email = `test-reg-${Date.now()}@example.com`;
    const res = await api().post('/api/v1/auth/register').send({ name: 'Reg User', email: email.toUpperCase(), password: 'Passw0rd1' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.email).toBe(email);
    expect(res.body.data.user.passwordHash).toBeUndefined();
    expect(res.body.data.token).toBeTruthy();

    const dup = await api().post('/api/v1/auth/register').send({ name: 'Reg User', email, password: 'Passw0rd1' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('always registers customers: a role sent by the client is ignored', async () => {
    const res = await api()
      .post('/api/v1/auth/register')
      .send({ name: 'Sneaky', email: `test-role-${Date.now()}@example.com`, password: 'Passw0rd1', role: 'admin' });
    expect(res.status).toBe(201);
    expect(res.body.data.user.role).toBe('user');
  });

  it('returns the role on login: demo customer is a user, demo admin is an admin', async () => {
    const customer = await api().post('/api/v1/auth/login').send({ email: 'demo@example.com', password: 'Demo@1234' });
    expect(customer.body.data.user.role).toBe('user');

    const admin = await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' });
    expect(admin.status).toBe(200);
    expect(admin.body.data.user.role).toBe('admin');

    const me = await api().get('/api/v1/users/me').set(auth(admin.body.data.token));
    expect(me.body.data.role).toBe('admin');
  });

  it('validates registration input with field-level details', async () => {
    const res = await api().post('/api/v1/auth/register').send({ name: 'A', email: 'nope', password: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d) => d.field)).toEqual(expect.arrayContaining(['name', 'email', 'password']));
  });

  it('logs in, and gives the same error for a wrong password and an unknown email', async () => {
    const { email } = await registerUser('login');
    const ok = await api().post('/api/v1/auth/login').send({ email, password: 'Passw0rd1' });
    expect(ok.status).toBe(200);

    const wrong = await api().post('/api/v1/auth/login').send({ email, password: 'Wrong1234' });
    const unknown = await api().post('/api/v1/auth/login').send({ email: 'test-ghost@example.com', password: 'Wrong1234' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.error).toEqual(unknown.body.error);
  });

  it('protects routes and rejects forged tokens', async () => {
    expect((await api().get('/api/v1/users/me')).status).toBe(401);
    expect((await api().get('/api/v1/users/me').set(auth('abc.def.ghi'))).status).toBe(401);
  });

  it('reads and updates the profile, and can clear the phone number', async () => {
    const { token } = await registerUser('profile');
    const upd = await api().patch('/api/v1/users/me').set(auth(token)).send({ name: 'New Name', phone: '+880 1700 000000' });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ name: 'New Name', phone: '+880 1700 000000' });

    const cleared = await api().patch('/api/v1/users/me').set(auth(token)).send({ phone: '' });
    expect(cleared.body.data.phone).toBeNull();

    expect((await api().patch('/api/v1/users/me').set(auth(token)).send({})).status).toBe(400);
  });

  it('changes the password only with the correct current password', async () => {
    const { token, email } = await registerUser('pw');
    const bad = await api().patch('/api/v1/users/me/password').set(auth(token)).send({ currentPassword: 'nope', newPassword: 'NewPass123' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('INVALID_CURRENT_PASSWORD');

    const good = await api().patch('/api/v1/users/me/password').set(auth(token)).send({ currentPassword: 'Passw0rd1', newPassword: 'NewPass123' });
    expect(good.status).toBe(200);
    expect((await api().post('/api/v1/auth/login').send({ email, password: 'NewPass123' })).status).toBe(200);
  });
});

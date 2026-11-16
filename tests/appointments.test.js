import { beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS, ADMIN_KEY, api, at, auth, dateIn, findService, registerUser } from './helpers.js';

const book = (token, serviceId, startTime, notes) =>
  api().post('/api/v1/appointments').set(auth(token)).send({ serviceId, startTime, address: ADDRESS, notes });

describe('availability and booking', () => {
  let massage, facial, a, b, c;
  const day = dateIn(20);

  beforeAll(async () => {
    massage = await findService('Swedish Massage'); // 60 min
    facial = await findService('Classic Facial'); // 45 min
    [a, b, c] = await Promise.all([registerUser('a'), registerUser('b'), registerUser('c')]);
  });

  it('requires auth and a valid, in-range date for availability', async () => {
    const url = `/api/v1/services/${massage.id}/availability`;
    expect((await api().get(url).query({ date: day })).status).toBe(401);
    expect((await api().get(url).set(auth(a.token)).query({ date: 'banana' })).status).toBe(400);
    expect((await api().get(url).set(auth(a.token)).query({ date: dateIn(-2) })).status).toBe(400);
    expect((await api().get(url).set(auth(a.token)).query({ date: dateIn(90) })).status).toBe(400);
  });

  it('generates the slot grid inside working hours', async () => {
    const res = await api().get(`/api/v1/services/${massage.id}/availability`).set(auth(a.token)).query({ date: day });
    expect(res.status).toBe(200);
    // 09:00-17:00, 30-min grid, 60-min service: last start is 16:00 => 15 slots
    expect(res.body.data.slots).toHaveLength(15);
    expect(res.body.data.slots[0].label).toBe('9:00 AM');
    expect(res.body.data.slots.every((s) => s.available)).toBe(true);
  });

  it('books a slot as pending and blocks overlapping slots, but allows back-to-back', async () => {
    const created = await book(a.token, massage.id, at(day, '10:00'), 'First visit');
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ status: 'pending', notes: 'First visit' });
    expect(created.body.data.service.name).toBe('Swedish Massage');

    const slots = await api().get(`/api/v1/services/${massage.id}/availability`).set(auth(b.token)).query({ date: day });
    const taken = slots.body.data.slots.filter((s) => !s.available).map((s) => s.label);
    expect(taken).toEqual(['9:30 AM', '10:00 AM', '10:30 AM']);

    const overlap = await book(b.token, massage.id, at(day, '10:30'));
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('SLOT_UNAVAILABLE');

    expect((await book(b.token, massage.id, at(day, '11:00'))).status).toBe(201);
  });

  it('stops one user holding two overlapping bookings', async () => {
    const res = await book(a.token, facial.id, at(day, '10:30'));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('USER_OVERLAP');
  });

  it('requires a service address and returns it on the booking', async () => {
    const missing = await api()
      .post('/api/v1/appointments')
      .set(auth(c.token))
      .send({ serviceId: massage.id, startTime: at(day, '15:00') });
    expect(missing.status).toBe(400);
    expect(missing.body.error.details.map((d) => d.field)).toContain('address');

    const tooShort = await api()
      .post('/api/v1/appointments')
      .set(auth(c.token))
      .send({ serviceId: massage.id, startTime: at(day, '15:00'), address: 'abc' });
    expect(tooShort.status).toBe(400);

    const created = await book(c.token, massage.id, at(day, '15:00'));
    expect(created.status).toBe(201);
    expect(created.body.data.address).toBe(ADDRESS);
    const fetched = await api().get(`/api/v1/appointments/${created.body.data.id}`).set(auth(c.token));
    expect(fetched.body.data.address).toBe(ADDRESS);
    await api().patch(`/api/v1/appointments/${created.body.data.id}/cancel`).set(auth(c.token));
  });

  it('rejects invalid slots and inputs', async () => {
    expect((await book(c.token, massage.id, at(day, '10:10'))).body.error.code).toBe('INVALID_SLOT'); // off-grid
    expect((await book(c.token, massage.id, at(day, '20:00'))).status).toBe(400); // after hours
    expect((await book(c.token, massage.id, at(day, '16:30'))).status).toBe(400); // would end after closing
    expect((await book(c.token, massage.id, at(dateIn(-1), '10:00'))).status).toBe(400); // past
    expect((await book(c.token, 'nope', at(day, '12:00'))).status).toBe(400);
    expect((await book(c.token, '00000000-0000-4000-8000-000000000000', at(day, '12:00'))).status).toBe(404);
    expect((await api().post('/api/v1/appointments').send({})).status).toBe(401);
  });

  it('never double-books under concurrent requests (database constraint)', async () => {
    const results = await Promise.all([
      book(b.token, facial.id, at(day, '14:00')),
      book(c.token, facial.id, at(day, '14:00')),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409).body.error.code).toBe('SLOT_UNAVAILABLE');
  });

  it('lists upcoming/past, and only the owner can read an appointment', async () => {
    const mine = await api().get('/api/v1/appointments').set(auth(a.token)).query({ scope: 'upcoming' });
    expect(mine.status).toBe(200);
    expect(mine.body.data.length).toBeGreaterThan(0);
    const id = mine.body.data[0].id;

    expect((await api().get(`/api/v1/appointments/${id}`).set(auth(a.token))).status).toBe(200);
    expect((await api().get(`/api/v1/appointments/${id}`).set(auth(c.token))).status).toBe(404);

    const past = await api().get('/api/v1/appointments').set(auth(a.token)).query({ scope: 'past' });
    expect(past.body.data.some((x) => x.id === id)).toBe(false);
  });

  it('cancels only pending appointments, only for the owner, and frees the slot', async () => {
    const created = await book(c.token, massage.id, at(day, '13:00'));
    const id = created.body.data.id;

    expect((await api().patch(`/api/v1/appointments/${id}/cancel`).set(auth(a.token))).status).toBe(404);

    const cancelled = await api().patch(`/api/v1/appointments/${id}/cancel`).set(auth(c.token));
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('cancelled');

    const again = await api().patch(`/api/v1/appointments/${id}/cancel`).set(auth(c.token));
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('NOT_CANCELLABLE');

    const past = await api().get('/api/v1/appointments').set(auth(c.token)).query({ scope: 'past' });
    expect(past.body.data.some((x) => x.id === id)).toBe(true);

    expect((await book(a.token, massage.id, at(day, '13:00'))).status).toBe(201); // slot free again
  });

  it('moves status forward through the admin endpoint with valid transitions only', async () => {
    const created = await book(b.token, facial.id, at(day, '16:00'));
    const id = created.body.data.id;
    const patch = (status, key = ADMIN_KEY) =>
      api().patch(`/api/v1/admin/appointments/${id}/status`).set('X-Admin-Key', key).send({ status });

    expect((await patch('confirmed', 'wrong-key')).status).toBe(403);
    expect((await patch('completed')).body.error.code).toBe('INVALID_TRANSITION'); // pending -> completed
    expect((await patch('confirmed')).body.data.status).toBe('confirmed');

    const cancel = await api().patch(`/api/v1/appointments/${id}/cancel`).set(auth(b.token));
    expect(cancel.status).toBe(409); // confirmed bookings cannot be cancelled by the user

    expect((await patch('completed')).body.data.status).toBe('completed');
  });
});

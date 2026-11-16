import { beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS, ADMIN_KEY, api, at, auth, dateIn, findService, registerUser } from './helpers.js';

const list = (token, query = {}) => api().get('/api/v1/notifications').set(auth(token)).query(query);

describe('notifications', () => {
  let massage, customer, other, adminToken, appointmentId;
  const day = dateIn(35);

  beforeAll(async () => {
    massage = await findService('Swedish Massage');
    customer = await registerUser('notif');
    other = await registerUser('notif-other');
    const login = await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' });
    adminToken = login.body.data.token;
  });

  it('requires authentication', async () => {
    expect((await api().get('/api/v1/notifications')).status).toBe(401);
    expect((await api().get('/api/v1/notifications/unread-count')).status).toBe(401);
  });

  it('starts empty for a new user', async () => {
    const res = await list(customer.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
    expect(res.body.meta.unreadCount).toBe(0);
  });

  it('booking notifies the customer and every admin', async () => {
    const booked = await api()
      .post('/api/v1/appointments')
      .set(auth(customer.token))
      .send({ serviceId: massage.id, startTime: at(day, '10:00'), address: ADDRESS });
    expect(booked.status).toBe(201);
    appointmentId = booked.body.data.id;

    const mine = await list(customer.token);
    expect(mine.body.data).toHaveLength(1);
    expect(mine.body.data[0]).toMatchObject({ type: 'booking_created', isRead: false, data: { appointmentId } });
    expect(mine.body.data[0].body).toContain('Swedish Massage');
    expect(mine.body.meta.unreadCount).toBe(1);

    const adminList = await list(adminToken, { limit: 50 });
    const forAdmin = adminList.body.data.find((n) => n.type === 'booking_new' && n.data?.appointmentId === appointmentId);
    expect(forAdmin).toBeTruthy();
    expect(forAdmin.body).toContain('Test notif'); // the customer's name
  });

  it('reports the unread count and marks one notification as read', async () => {
    expect((await api().get('/api/v1/notifications/unread-count').set(auth(customer.token))).body.data.unreadCount).toBe(1);
    const id = (await list(customer.token)).body.data[0].id;

    const read = await api().patch(`/api/v1/notifications/${id}/read`).set(auth(customer.token));
    expect(read.status).toBe(200);
    expect(read.body.data.isRead).toBe(true);

    expect((await api().get('/api/v1/notifications/unread-count').set(auth(customer.token))).body.data.unreadCount).toBe(0);
    expect((await list(customer.token, { unread: 'true' })).body.data).toHaveLength(0);
  });

  it("cannot read or mark someone else's notification", async () => {
    const id = (await list(customer.token)).body.data[0].id;
    expect((await api().patch(`/api/v1/notifications/${id}/read`).set(auth(other.token))).status).toBe(404);
    expect((await list(other.token)).body.data).toEqual([]);
    expect((await api().patch('/api/v1/notifications/not-a-uuid/read').set(auth(customer.token))).status).toBe(400);
  });

  it('an admin status change notifies the customer, and mark-all-read clears the badge', async () => {
    const confirm = await api()
      .patch(`/api/v1/admin/appointments/${appointmentId}/status`)
      .set('X-Admin-Key', ADMIN_KEY)
      .send({ status: 'confirmed' });
    expect(confirm.status).toBe(200);

    const unread = await list(customer.token, { unread: 'true' });
    expect(unread.body.data).toHaveLength(1);
    expect(unread.body.data[0]).toMatchObject({ type: 'booking_confirmed', title: 'Booking confirmed' });

    const all = await api().post('/api/v1/notifications/read-all').set(auth(customer.token));
    expect(all.body.data.updated).toBe(1);
    expect((await list(customer.token)).body.meta.unreadCount).toBe(0);
    expect((await list(customer.token)).body.data).toHaveLength(2);
  });

  it('a customer cancelling notifies the admins', async () => {
    const second = await api()
      .post('/api/v1/appointments')
      .set(auth(other.token))
      .send({ serviceId: massage.id, startTime: at(day, '13:00'), address: ADDRESS });
    const id = second.body.data.id;
    await api().patch(`/api/v1/appointments/${id}/cancel`).set(auth(other.token));

    const adminList = await list(adminToken, { limit: 50 });
    const cancelled = adminList.body.data.find((n) => n.type === 'booking_cancelled' && n.data?.appointmentId === id);
    expect(cancelled).toBeTruthy();
    expect(cancelled.body).toContain('cancelled');
  });
});

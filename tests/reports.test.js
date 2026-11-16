import { beforeAll, describe, expect, it } from 'vitest';
import { ADDRESS, api, at, auth, dateIn, findService, paymentMethodId, registerUser } from './helpers.js';

describe('admin dashboard and sales reports', () => {
  let admin, customer, massage, yoga, cash, bkash;
  const day = dateIn(60);
  const ids = {};

  beforeAll(async () => {
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
    customer = await registerUser('rep');
    massage = await findService('Swedish Massage'); // 2500
    yoga = await findService('Private Yoga Class'); // 1200
    cash = await paymentMethodId('cash');
    bkash = await paymentMethodId('bkash');
  });

  const adminGet = (path, query = {}) => api().get(`/api/v1/admin${path}`).set(auth(admin.token)).query(query);
  const book = (service, time, method, ref) =>
    api()
      .post('/api/v1/appointments')
      .set(auth(customer.token))
      .send({ serviceId: service.id, startTime: at(day, time), address: ADDRESS, paymentMethodId: method, paymentReference: ref });
  const setStatus = (id, status) =>
    api().patch(`/api/v1/admin/appointments/${id}/status`).set(auth(admin.token)).send({ status });

  it('sales count confirmed and completed bookings only, at the price paid', async () => {
    const before = (await adminGet('/dashboard')).body.data;

    ids.a = (await book(massage, '09:00', cash)).body.data.id; // will be confirmed
    ids.b = (await book(yoga, '11:00', bkash, 'TRX9999AAA')).body.data.id; // completed + paid
    ids.c = (await book(massage, '13:00', cash)).body.data.id; // cancelled
    ids.d = (await book(yoga, '15:00', cash)).body.data.id; // stays pending

    // Pending and cancelled bookings are not sales.
    const early = (await adminGet('/dashboard')).body.data;
    expect(early.sales.allTime.revenue).toBe(before.sales.allTime.revenue);
    expect(early.sales.pipeline.value).toBe(before.sales.pipeline.value + 2500 + 1200 + 2500 + 1200);

    await setStatus(ids.a, 'confirmed');
    await setStatus(ids.b, 'confirmed');
    await setStatus(ids.b, 'completed');
    await api().patch(`/api/v1/admin/appointments/${ids.b}/payment`).set(auth(admin.token)).send({ status: 'paid' });
    await setStatus(ids.c, 'cancelled');

    const after = (await adminGet('/dashboard')).body.data;
    expect(after.sales.allTime.revenue - before.sales.allTime.revenue).toBe(2500 + 1200);
    expect(after.sales.allTime.bookings - before.sales.allTime.bookings).toBe(2);
    expect(after.byStatus.cancelled).toBeGreaterThanOrEqual(1);
    expect(after.totals.pendingBookings).toBeGreaterThanOrEqual(1);
  });

  it('the dashboard has the expected shape', async () => {
    const d = (await adminGet('/dashboard')).body.data;
    expect(d.timeZone).toBe('UTC');
    expect(d.totals).toEqual(
      expect.objectContaining({
        services: expect.any(Number),
        customers: expect.any(Number),
        bookings: expect.any(Number),
        pendingBookings: expect.any(Number),
        pendingDiscountRequests: expect.any(Number),
        pendingPayments: expect.any(Number),
      }),
    );
    expect(d.sales).toEqual(
      expect.objectContaining({
        today: expect.objectContaining({ bookings: expect.any(Number), revenue: expect.any(Number) }),
        thisMonth: expect.any(Object),
        allTime: expect.any(Object),
        pipeline: expect.objectContaining({ value: expect.any(Number) }),
      }),
    );
    expect(Object.keys(d.byStatus).sort()).toEqual(['cancelled', 'completed', 'confirmed', 'pending']);
    expect(d.daily).toHaveLength(14);
    expect(d.daily.at(-1).date).toBe(new Date().toISOString().slice(0, 10));
    expect(d.topServices.length).toBeLessThanOrEqual(5);
    expect(d.recentBookings.length).toBeGreaterThan(0);
    expect(d.recentBookings[0].customer).toHaveProperty('email');
  });

  it('the day report totals revenue, discounts, paid and unpaid amounts', async () => {
    const res = await adminGet('/reports/sales', { from: day, to: day, groupBy: 'day' });
    expect(res.status).toBe(200);
    expect(res.body.data.summary).toMatchObject({
      revenue: 3700,
      bookings: 2,
      averageOrderValue: 1850,
      discountsGiven: 0,
      paidAmount: 1200,
      unpaidAmount: 2500,
      cancelledBookings: 1,
      pendingBookings: 1,
    });
    expect(res.body.data.rows).toEqual([{ key: day, bookings: 2, revenue: 3700, discounts: 0 }]);
  });

  it('groups by service, category and payment method', async () => {
    const byService = (await adminGet('/reports/sales', { from: day, to: day, groupBy: 'service' })).body.data;
    expect(byService.rows.map((r) => [r.key, r.revenue])).toEqual([
      ['Swedish Massage', 2500],
      ['Private Yoga Class', 1200],
    ]);

    const byCategory = (await adminGet('/reports/sales', { from: day, to: day, groupBy: 'category' })).body.data;
    expect(byCategory.rows.map((r) => r.key).sort()).toEqual(['Fitness', 'Wellness']);

    const byPayment = (await adminGet('/reports/sales', { from: day, to: day, groupBy: 'payment' })).body.data;
    expect(byPayment.rows.map((r) => [r.key, r.revenue]).sort()).toEqual([
      ['Cash on service', 2500],
      ['bKash', 1200],
    ]);
  });

  it('fills empty days in a date range and exports CSV', async () => {
    const from = dateIn(58);
    const to = dateIn(61);
    const report = (await adminGet('/reports/sales', { from, to })).body.data;
    expect(report.rows).toHaveLength(4);
    expect(report.rows.find((r) => r.key === day).revenue).toBe(3700);
    expect(report.rows.find((r) => r.key === from).revenue).toBe(0);

    const csv = await adminGet('/reports/sales.csv', { from: day, to: day, groupBy: 'service' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.headers['content-disposition']).toContain(`seba-sales-${day}_${day}.csv`);
    expect(csv.text.split('\n')).toEqual([
      'Service,Bookings,Revenue (BDT),Discounts (BDT)',
      'Swedish Massage,1,2500,0',
      'Private Yoga Class,1,1200,0',
      'Total,2,3700,0',
    ]);
  });

  it('validates the report range', async () => {
    expect((await adminGet('/reports/sales', { from: day, to: dateIn(1) })).status).toBe(400); // from after to
    expect((await adminGet('/reports/sales', { from: '2020-01-01', to: '2024-01-01' })).status).toBe(400); // too long
    expect((await adminGet('/reports/sales', { from: 'banana' })).status).toBe(400);
    expect((await adminGet('/reports/sales', { groupBy: 'weather' })).status).toBe(400);
    expect((await adminGet('/reports/sales')).status).toBe(200); // defaults to the last 30 days
  });

  it('the admin booking list filters by status, payment status and search', async () => {
    const pending = (await adminGet('/appointments', { status: 'pending', search: customer.email })).body.data;
    expect(pending.map((a) => a.id)).toEqual([ids.d]);
    expect(pending[0].customer.email).toBe(customer.email);

    const submitted = (await adminGet('/appointments', { paymentStatus: 'paid', search: 'Yoga', from: day, to: day })).body.data;
    expect(submitted.map((a) => a.id)).toEqual([ids.b]);

    const byDay = (await adminGet('/appointments', { from: day, to: day, limit: 50 })).body;
    expect(byDay.meta.total).toBe(4);
    expect((await adminGet(`/appointments/${ids.a}`)).body.data.status).toBe('confirmed');
    expect((await adminGet('/appointments/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });
});

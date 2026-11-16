import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { ADDRESS, api, at, auth, dateIn, findService, paymentMethodId, registerUser } from './helpers.js';

// Online payment through the built-in demo checkout (a stand-in for SSLCommerz / aamarPay).
const GW = '/api/v1/payments/gateway';
let massage, GATEWAY;
let dayOffset = 30;

async function bookFor(user, { method = GATEWAY } = {}) {
  const day = dateIn(dayOffset++);
  const res = await api()
    .post('/api/v1/appointments')
    .set(auth(user.token))
    .send({ serviceId: massage.id, startTime: at(day, '10:00'), address: ADDRESS, paymentMethodId: method });
  expect(res.status).toBe(201);
  return res.body.data;
}
const pay = (user, id, body = {}) => api().post(`/api/v1/appointments/${id}/pay-online`).set(auth(user.token)).send(body);
const tranIdOf = (url) => url.split('/').pop();
const callback = (path, form) => api().post(`${GW}${path}`).type('form').send(form);
const fetchBooking = async (user, id) => (await api().get(`/api/v1/appointments/${id}`).set(auth(user.token))).body.data;

describe('online payments (demo checkout)', () => {
  let customer, other;

  beforeAll(async () => {
    massage = await findService('Swedish Massage'); // ৳2,500
    GATEWAY = await paymentMethodId('demo_gateway');
    [customer, other] = await Promise.all([registerUser('pay-a'), registerUser('pay-b')]);
  });

  it('lists the online option only because its gateway is available', async () => {
    const res = await api().get('/api/v1/payment-methods').set(auth(customer.token));
    const codes = res.body.data.map((m) => m.code);
    expect(codes).toContain('demo_gateway');
    expect(codes).not.toContain('sslcommerz'); // not configured in tests
    expect(codes).not.toContain('aamarpay');
    expect(res.body.data.find((m) => m.code === 'demo_gateway').online).toBe(true);
    expect(res.body.data.find((m) => m.code === 'cash').online).toBe(false);
  });

  it('creates a checkout link for the exact price and marks the booking paid after the gateway confirms', async () => {
    const booking = await bookFor(customer);
    expect(booking).toMatchObject({ canPayOnline: true, paymentStatus: 'unpaid', price: 2500 });
    expect(booking.paymentMethod.online).toBe(true);

    const started = await pay(customer, booking.id);
    expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ provider: 'mock', amount: 2500, currency: 'BDT' });
    const tranId = tranIdOf(started.body.data.url);

    const checkout = await api().get(`${GW}/mock/checkout/${tranId}`);
    expect(checkout.status).toBe(200);
    expect(checkout.text).toContain('৳2,500');

    // Opening the page does not pay.
    expect((await fetchBooking(customer, booking.id)).paymentStatus).toBe('unpaid');

    const done = await callback('/mock/success', { tran_id: tranId, status: 'paid' });
    expect(done.status).toBe(200);
    expect(done.text).toContain('Payment received');

    const after = await fetchBooking(customer, booking.id);
    expect(after).toMatchObject({ paymentStatus: 'paid', canPayOnline: false });
    expect(after.paymentReference).toMatch(/^DEMO-/);
    expect(after.paidAt).toBeTruthy();

    const notes = await api().get('/api/v1/notifications').set(auth(customer.token));
    expect(notes.body.data.some((n) => n.type === 'payment_received')).toBe(true);

    // A repeated callback is harmless and a paid booking cannot be paid again.
    expect((await callback('/mock/success', { tran_id: tranId, status: 'paid' })).text).toContain('Payment received');
    expect((await pay(customer, booking.id)).body.error.code).toBe('ALREADY_PAID');
    expect(await prisma.paymentSession.count({ where: { appointmentId: booking.id, status: 'paid' } })).toBe(1);
  });

  it('keeps the booking unpaid when the payment fails or is cancelled, and allows another try', async () => {
    const booking = await bookFor(customer);
    const first = tranIdOf((await pay(customer, booking.id)).body.data.url);
    const failed = await callback('/mock/fail', { tran_id: first });
    expect(failed.text).toContain('not completed');

    const second = tranIdOf((await pay(customer, booking.id)).body.data.url);
    expect(second).not.toBe(first);
    expect((await callback('/mock/cancel', { tran_id: second })).text).toContain('cancelled');

    expect(await fetchBooking(customer, booking.id)).toMatchObject({ paymentStatus: 'unpaid', canPayOnline: true });

    // A dead session's checkout page is gone.
    expect((await api().get(`${GW}/mock/checkout/${first}`)).status).toBe(404);
  });

  it('only accepts a payment that the gateway says succeeded', async () => {
    const booking = await bookFor(customer);
    const tranId = tranIdOf((await pay(customer, booking.id)).body.data.url);
    const res = await callback('/mock/success', { tran_id: tranId, status: 'failed' });
    expect(res.text).toContain('not completed');
    expect((await fetchBooking(customer, booking.id)).paymentStatus).toBe('unpaid');
  });

  it('protects other customers, cancelled bookings and unknown transactions', async () => {
    const booking = await bookFor(customer);
    expect((await pay(other, booking.id)).status).toBe(404);
    expect((await api().post(`/api/v1/appointments/${booking.id}/pay-online`).send({})).status).toBe(401);
    expect((await pay(customer, booking.id, { provider: 'paypal' })).status).toBe(400);
    expect((await pay(customer, booking.id, { provider: 'sslcommerz' })).body.error.code).toBe('PROVIDER_UNAVAILABLE');

    expect((await callback('/mock/success', { tran_id: 'SEBANOTREAL', status: 'paid' })).status).toBe(404);
    expect((await callback('/sslcommerz/success', { tran_id: 'x', val_id: 'y' })).status).toBe(404); // gateway not configured
    expect((await callback('/mock/refund', { tran_id: 'x' })).status).toBe(404);

    await api().patch(`/api/v1/appointments/${booking.id}/cancel`).set(auth(customer.token));
    expect((await pay(customer, booking.id)).body.error.code).toBe('NOT_PAYABLE');
  });

  it('can pay a booking that was made with cash by switching to the online method', async () => {
    const cash = await paymentMethodId('cash');
    const booking = await bookFor(customer, { method: cash });
    expect(booking.canPayOnline).toBe(true);
    expect((await pay(customer, booking.id)).status).toBe(201);
    expect((await fetchBooking(customer, booking.id)).paymentMethod.code).toBe('demo_gateway');
  });

  it('a discounted booking is charged the discounted price', async () => {
    const booking = await bookFor(customer);
    await prisma.appointment.update({ where: { id: booking.id }, data: { price: 2000, discountAmount: 500 } });
    expect((await pay(customer, booking.id)).body.data.amount).toBe(2000);
  });
});

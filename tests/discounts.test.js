import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { createDiscountRequest } from '../src/modules/discounts/discount.service.js';
import { ADDRESS, api, at, auth, dateIn, findService, paymentMethodId, registerUser } from './helpers.js';

describe('discount requests: admin approval, one order only', () => {
  let admin, alice, bob, massage, facial, cash;
  const day = dateIn(55);

  beforeAll(async () => {
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
    [alice, bob] = await Promise.all([registerUser('disc-alice'), registerUser('disc-bob')]);
    massage = await findService('Swedish Massage'); // 2500
    facial = await findService('Classic Facial'); // 1800
    cash = await paymentMethodId('cash');
  });

  afterAll(async () => {
    await prisma.notification.deleteMany({ where: { body: { contains: 'Test disc-' } } });
  });

  const book = (who, service, time) =>
    api()
      .post('/api/v1/appointments')
      .set(auth(who.token))
      .send({ serviceId: service.id, startTime: at(day, time), address: ADDRESS, paymentMethodId: cash });
  const mine = async (who) => (await api().get('/api/v1/discount-requests').set(auth(who.token))).body.data;
  const decide = (id, action, body, token = admin.token) =>
    api().patch(`/api/v1/admin/discount-requests/${id}/${action}`).set(auth(token)).send(body);

  let requestId;

  it('a request is created once per service, tells the admins and waits as pending', async () => {
    const first = await createDiscountRequest(alice.id, { serviceId: massage.id, message: 'Can I get a discount?', language: 'en' });
    expect(first.created).toBe(true);
    requestId = first.request.id;
    const again = await createDiscountRequest(alice.id, { serviceId: massage.id, message: 'Please, a discount?', language: 'en' });
    expect(again.created).toBe(false);
    expect(again.request.id).toBe(requestId);

    const list = await mine(alice);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ status: 'pending', language: 'en', service: { name: 'Swedish Massage' } });
    expect(list[0].reply).toBeNull();
    expect(await mine(bob)).toEqual([]); // customers only see their own requests

    const adminNotes = (await api().get('/api/v1/notifications').query({ limit: 50 }).set(auth(admin.token))).body.data;
    expect(adminNotes.some((n) => n.type === 'discount_request' && n.data?.discountRequestId === requestId)).toBe(true);

    const pending = await api().get('/api/v1/admin/discount-requests').query({ status: 'pending' }).set(auth(admin.token));
    const row = pending.body.data.find((r) => r.id === requestId);
    expect(row.customer.email).toBe(alice.email);
  });

  it('only admins can decide, and the discount must be valid', async () => {
    expect((await decide(requestId, 'approve', { type: 'percent', value: 20 }, alice.token)).status).toBe(403);
    expect((await decide(requestId, 'approve', { type: 'percent', value: 95 })).status).toBe(400); // above the cap
    expect((await decide(requestId, 'approve', { type: 'percent', value: 0 })).status).toBe(400);
    expect((await decide(requestId, 'approve', { type: 'fixed', value: 99999 })).status).toBe(400); // more than the price
    expect((await decide(requestId, 'approve', { type: 'weird', value: 5 })).status).toBe(400);
    expect((await decide('00000000-0000-4000-8000-000000000000', 'decline', {})).status).toBe(404);
  });

  it('approving answers the customer (in their language) and notifies them', async () => {
    const approved = await decide(requestId, 'approve', { type: 'percent', value: 20, expiresInDays: 7, note: 'Loyal customer' });
    expect(approved.status).toBe(200);
    expect(approved.body.data).toMatchObject({ status: 'approved', discountType: 'percent', discountValue: 20, adminNote: 'Loyal customer' });
    expect(approved.body.data.expiresAt).toBeTruthy();

    const [req] = await mine(alice);
    expect(req.status).toBe('approved');
    expect(req.reply).toContain('20%'); // template reply (Gemini is off in tests)
    expect(req.reply).toContain('Swedish Massage');
    expect(req).not.toHaveProperty('adminNote'); // internal note stays with admins

    const notes = (await api().get('/api/v1/notifications').set(auth(alice.token))).body.data;
    expect(notes.some((n) => n.type === 'discount_approved' && n.body.includes('20%'))).toBe(true);

    expect((await decide(requestId, 'approve', { type: 'percent', value: 10 })).status).toBe(409); // already decided
    expect((await decide(requestId, 'decline', {})).status).toBe(409);
  });

  it("applies to that customer's next booking of that service only, and only once", async () => {
    const first = await book(alice, massage, '09:00');
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ originalPrice: 2500, discountAmount: 500, price: 2000 });
    expect((await mine(alice))[0].status).toBe('used');

    // A new order gets the current price.
    const second = await book(alice, massage, '12:00');
    expect(second.body.data).toMatchObject({ originalPrice: 2500, discountAmount: 0, price: 2500 });

    // Someone else never gets it.
    const other = await book(bob, massage, '14:00');
    expect(other.body.data).toMatchObject({ discountAmount: 0, price: 2500 });
  });

  it('cancelling the discounted booking gives the discount back, for the next order only', async () => {
    const discounted = (await api().get('/api/v1/appointments').set(auth(alice.token)).query({ scope: 'upcoming' })).body.data.find(
      (a) => a.discountAmount === 500,
    );
    const cancelled = await api().patch(`/api/v1/appointments/${discounted.id}/cancel`).set(auth(alice.token));
    expect(cancelled.status).toBe(200);
    expect((await mine(alice))[0].status).toBe('approved');

    const next = await book(alice, massage, '15:00');
    expect(next.body.data).toMatchObject({ discountAmount: 500, price: 2000 });
    expect((await mine(alice))[0].status).toBe('used');
    expect((await book(alice, massage, '16:00')).body.data.discountAmount).toBe(0);
  });

  it('a general fixed discount applies to any service; an expired one does not', async () => {
    const general = await createDiscountRequest(bob.id, { serviceId: null, message: 'Any discount please', language: 'banglish' });
    const approved = await decide(general.request.id, 'approve', { type: 'fixed', value: 100 });
    expect(approved.body.data.service).toBeNull();
    expect(approved.body.data.language).toBe('banglish');
    expect(approved.body.data.reply).toMatch(/discount|Discount/); // Banglish template (Latin letters)
    expect(approved.body.data.reply).not.toMatch(/[ঀ-৲৴-৿]/); // Latin letters only (the ৳ sign is allowed)

    // Expire it in the database: it must stop applying and read as expired.
    await prisma.discountRequest.update({ where: { id: general.request.id }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    const bobList = await mine(bob);
    expect(bobList.find((r) => r.id === general.request.id).status).toBe('expired');
    const expired = await book(bob, facial, '09:00');
    expect(expired.body.data).toMatchObject({ discountAmount: 0, price: 1800 });

    // A fresh general request that is still valid takes ৳100 off any service.
    const fresh = await createDiscountRequest(bob.id, { serviceId: null, message: 'One more try', language: 'bn' });
    const ok = await decide(fresh.request.id, 'approve', { type: 'fixed', value: 100 });
    expect(ok.body.data.reply).toMatch(/[ঀ-৲৴-৿]/); // Bangla template (Bengali letters)
    const applied = await book(bob, facial, '11:00');
    expect(applied.body.data).toMatchObject({ originalPrice: 1800, discountAmount: 100, price: 1700 });
  });

  it('a declined request answers the customer politely and gives no discount', async () => {
    const declinedReq = await createDiscountRequest(alice.id, { serviceId: facial.id, message: 'Cheaper?', language: 'en' });
    const declined = await decide(declinedReq.request.id, 'decline', { note: 'Prices are already discounted' });
    expect(declined.status).toBe(200);
    expect(declined.body.data.status).toBe('declined');

    const entry = (await mine(alice)).find((r) => r.id === declinedReq.request.id);
    expect(entry.reply).toContain('Prices are already discounted');
    const notes = (await api().get('/api/v1/notifications').set(auth(alice.token))).body.data;
    expect(notes.some((n) => n.type === 'discount_declined')).toBe(true);
    expect((await book(alice, facial, '14:00')).body.data.discountAmount).toBe(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { ADDRESS, ADMIN_KEY, api, at, auth, dateIn, findService, paymentMethodId, registerUser } from './helpers.js';

const TAG = `T${Date.now().toString(36)}`;

describe('admin access control', () => {
  let customer, admin;

  beforeAll(async () => {
    customer = await registerUser('adm-acl');
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
  });

  it('rejects anonymous callers, customers and the ops key on admin-only routes', async () => {
    const routes = ['/services', '/service-fields', '/payment-methods', '/appointments', '/discount-requests', '/dashboard', '/reports/sales'];
    for (const path of routes) {
      expect((await api().get(`/api/v1/admin${path}`)).status).toBe(401);
      expect((await api().get(`/api/v1/admin${path}`).set(auth(customer.token))).status).toBe(403);
      // The static ops key only works for the booking status route, not for admin screens.
      expect((await api().get(`/api/v1/admin${path}`).set('X-Admin-Key', ADMIN_KEY)).status).toBe(401);
      expect((await api().get(`/api/v1/admin${path}`).set(auth(admin.token))).status).toBe(200);
    }
  });
});

describe('dynamic service form: custom fields and services', () => {
  let admin, customer, fieldKey, selectKey, serviceId;

  beforeAll(async () => {
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
    customer = await registerUser('adm-svc');
    fieldKey = `tz_req_${TAG.toLowerCase()}`;
    selectKey = `tz_sel_${TAG.toLowerCase()}`;
  });

  afterAll(async () => {
    await prisma.service.deleteMany({ where: { name: { startsWith: `Test Service ${TAG}` } } });
    await prisma.serviceField.deleteMany({ where: { key: { in: [fieldKey, selectKey] } } });
  });

  const post = (path, body) => api().post(`/api/v1/admin${path}`).set(auth(admin.token)).send(body);
  const patch = (path, body) => api().patch(`/api/v1/admin${path}`).set(auth(admin.token)).send(body);
  const baseService = (over = {}) => ({
    name: `Test Service ${TAG}`,
    description: 'A service created by the automated tests.',
    price: 1500,
    durationMinutes: 60,
    category: 'Wellness',
    ...over,
  });

  it('admin adds a custom field (text, required) and a dropdown field', async () => {
    const text = await post('/service-fields', { label: 'Provider notes', key: fieldKey, type: 'text', required: true });
    expect(text.status).toBe(201);
    expect(text.body.data).toMatchObject({ key: fieldKey, type: 'text', required: true, isActive: true });

    const dup = await post('/service-fields', { label: 'Provider notes', key: fieldKey, type: 'text' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('FIELD_KEY_TAKEN');

    const select = await post('/service-fields', { label: 'Level', key: selectKey, type: 'select', options: ['Basic', 'Pro'] });
    expect(select.status).toBe(201);
    expect(select.body.data.options).toEqual(['Basic', 'Pro']);

    expect((await post('/service-fields', { label: 'Bad dropdown', type: 'select' })).status).toBe(400); // needs options
    expect((await post('/service-fields', { label: 'x', type: 'text' })).status).toBe(400); // label too short

    const list = await api().get('/api/v1/admin/service-fields').set(auth(admin.token));
    expect(list.body.data.map((f) => f.key)).toEqual(expect.arrayContaining([fieldKey, selectKey, 'staff_level']));
  });

  it('validates the service form including the custom fields', async () => {
    expect((await post('/services', baseService())).status).toBe(400); // required custom field missing
    const missing = await post('/services', baseService());
    expect(missing.body.error.details.map((d) => d.field)).toContain(`attributes.${fieldKey}`);

    const unknown = await post('/services', baseService({ attributes: { [fieldKey]: 'ok', nope: 1 } }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details.map((d) => d.field)).toContain('attributes.nope');

    const badSelect = await post('/services', baseService({ attributes: { [fieldKey]: 'ok', [selectKey]: 'Wizard' } }));
    expect(badSelect.status).toBe(400);

    expect((await post('/services', baseService({ price: -5, attributes: { [fieldKey]: 'ok' } }))).status).toBe(400);
    expect((await post('/services', baseService({ name: 'x', attributes: { [fieldKey]: 'ok' } }))).status).toBe(400);
  });

  it('creates a service with custom values and shows them to customers', async () => {
    const created = await post('/services', baseService({
      isFeatured: true,
      imageUrl: 'https://example.com/photo.jpg',
      attributes: { [fieldKey]: 'Bring a towel', [selectKey]: 'Pro' },
    }));
    expect(created.status).toBe(201);
    serviceId = created.body.data.id;
    expect(created.body.data).toMatchObject({ name: `Test Service ${TAG}`, price: 1500, isActive: true, isFeatured: true });
    expect(created.body.data.attributeValues).toEqual({ [fieldKey]: 'Bring a towel', [selectKey]: 'Pro' });

    const dup = await post('/services', baseService({ attributes: { [fieldKey]: 'x' } }));
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SERVICE_NAME_TAKEN');

    const seen = await api().get(`/api/v1/services/${serviceId}`);
    expect(seen.status).toBe(200);
    expect(seen.body.data.attributes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: fieldKey, label: 'Provider notes', value: 'Bring a towel' }),
        expect.objectContaining({ key: selectKey, value: 'Pro' }),
      ]),
    );
    const listed = await api().get('/api/v1/services').query({ search: `Test Service ${TAG}` });
    expect(listed.body.data.map((s) => s.id)).toContain(serviceId);
  });

  it('edits a service, and deactivating hides it from customers but not from admins', async () => {
    const updated = await patch(`/services/${serviceId}`, { price: 1800, attributes: { [fieldKey]: 'Updated note' } });
    expect(updated.status).toBe(200);
    expect(updated.body.data.price).toBe(1800);
    expect(updated.body.data.attributeValues[fieldKey]).toBe('Updated note');

    // Only the price/attributes were sent: the featured flag must not be reset.
    expect(updated.body.data.isFeatured).toBe(true);
    expect(updated.body.data.isActive).toBe(true);
    expect((await patch(`/services/${serviceId}`, {})).status).toBe(400);
    expect((await patch('/services/00000000-0000-4000-8000-000000000000', { price: 1 })).status).toBe(404);

    const off = await api().delete(`/api/v1/admin/services/${serviceId}`).set(auth(admin.token));
    expect(off.status).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect((await api().get(`/api/v1/services/${serviceId}`)).status).toBe(404);
    expect((await api().get('/api/v1/services').query({ search: `Test Service ${TAG}` })).body.data).toHaveLength(0);

    const adminList = await api().get('/api/v1/admin/services').query({ status: 'inactive', search: `Test Service ${TAG}` }).set(auth(admin.token));
    expect(adminList.body.data.map((s) => s.id)).toContain(serviceId);

    const back = await patch(`/services/${serviceId}`, { isActive: true });
    expect(back.body.data.isActive).toBe(true);
    expect((await api().get(`/api/v1/services/${serviceId}`)).status).toBe(200);
  });

  it('deactivating a field hides its values from customers and stops it being required', async () => {
    const field = (await api().get('/api/v1/admin/service-fields').set(auth(admin.token))).body.data.find((f) => f.key === fieldKey);
    const off = await api().delete(`/api/v1/admin/service-fields/${field.id}`).set(auth(admin.token));
    expect(off.body.data.isActive).toBe(false);

    const seen = await api().get(`/api/v1/services/${serviceId}`);
    expect(seen.body.data.attributes.map((a) => a.key)).not.toContain(fieldKey);
    // With the required field off, a new service no longer needs it.
    const ok = await post('/services', baseService({ name: `Test Service ${TAG} B` }));
    expect(ok.status).toBe(201);
    expect(customer.token).toBeTruthy();
  });
});

describe('payment methods', () => {
  let admin, customer, code, methodId;

  beforeAll(async () => {
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
    customer = await registerUser('adm-pay');
    code = `test_pay_${TAG.toLowerCase()}`;
  });

  afterAll(async () => {
    await prisma.paymentMethod.deleteMany({ where: { code } });
  });

  it('customers see the active methods, admins manage them', async () => {
    const seeded = await api().get('/api/v1/payment-methods').set(auth(customer.token));
    expect(seeded.status).toBe(200);
    expect(seeded.body.data.map((m) => m.code)).toEqual(expect.arrayContaining(['cash', 'card', 'bkash', 'nagad']));
    expect(seeded.body.data.find((m) => m.code === 'bkash').requiresReference).toBe(true);
    expect((await api().get('/api/v1/payment-methods')).status).toBe(401);

    const created = await api().post('/api/v1/admin/payment-methods').set(auth(admin.token)).send({
      code,
      name: 'Rocket',
      type: 'mobile_wallet',
      requiresReference: true,
      instructions: 'Send to 01900-000000',
    });
    expect(created.status).toBe(201);
    methodId = created.body.data.id;
    expect((await api().post('/api/v1/admin/payment-methods').set(auth(admin.token)).send({ code, name: 'Dup', type: 'cash' })).status).toBe(409);

    expect((await api().get('/api/v1/payment-methods').set(auth(customer.token))).body.data.map((m) => m.code)).toContain(code);

    const off = await api().delete(`/api/v1/admin/payment-methods/${methodId}`).set(auth(admin.token));
    expect(off.body.data.isActive).toBe(false);
    expect((await api().get('/api/v1/payment-methods').set(auth(customer.token))).body.data.map((m) => m.code)).not.toContain(code);
  });

  it('a booking must use an active method, and wallet methods need a transaction ID', async () => {
    const service = await findService('Swedish Massage');
    const day = dateIn(45);
    const book = (body) =>
      api().post('/api/v1/appointments').set(auth(customer.token)).send({ serviceId: service.id, address: ADDRESS, ...body });

    expect((await book({ startTime: at(day, '10:00') })).status).toBe(400); // no payment method
    const inactive = await book({ startTime: at(day, '10:00'), paymentMethodId: methodId, paymentReference: 'ABCD1234' });
    expect(inactive.status).toBe(400);
    expect(inactive.body.error.code).toBe('INVALID_PAYMENT_METHOD');

    const bkash = await paymentMethodId('bkash');
    const noRef = await book({ startTime: at(day, '10:00'), paymentMethodId: bkash });
    expect(noRef.status).toBe(400);

    const ok = await book({ startTime: at(day, '10:00'), paymentMethodId: bkash, paymentReference: 'TRX12345AB' });
    expect(ok.status).toBe(201);
    expect(ok.body.data).toMatchObject({ paymentStatus: 'submitted', paymentReference: 'TRX12345AB' });
    expect(ok.body.data.paymentMethod.code).toBe('bkash');

    // The admin verifies the transaction; the customer is told.
    const paid = await api()
      .patch(`/api/v1/admin/appointments/${ok.body.data.id}/payment`)
      .set(auth(admin.token))
      .send({ status: 'paid' });
    expect(paid.status).toBe(200);
    expect(paid.body.data.paymentStatus).toBe('paid');
    expect(paid.body.data.paidAt).toBeTruthy();
    expect(paid.body.data.customer.email).toBe(customer.email);

    const notes = await api().get('/api/v1/notifications').set(auth(customer.token));
    expect(notes.body.data.map((n) => n.type)).toContain('payment_verified');

    const cash = await paymentMethodId('cash');
    const cashBooking = await book({ startTime: at(day, '13:00'), paymentMethodId: cash });
    expect(cashBooking.body.data.paymentStatus).toBe('unpaid');
  });
});

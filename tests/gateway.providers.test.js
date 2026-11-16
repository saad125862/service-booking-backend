import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Real gateway adapters with the network mocked: what we send, and that a payment is only
// accepted when the gateway's own confirmation matches the booking.
process.env.AAMARPAY_STORE_ID = 'aamarpaytest';
process.env.AAMARPAY_SIGNATURE_KEY = 'test-signature';
process.env.SSLCOMMERZ_STORE_ID = 'testbox';
process.env.SSLCOMMERZ_STORE_PASSWORD = 'testbox@ssl';
process.env.PUBLIC_API_URL = 'https://api.example.test';

const { prisma } = await import('../src/db/prisma.js');
const { ADDRESS, api, at, auth, dateIn, findService, paymentMethodId, registerUser } = await import('./helpers.js');

const GW = '/api/v1/payments/gateway';
const json = (body) => new Response(JSON.stringify(body), { status: 200 });
const sent = [];

// Mocks the gateway's servers only: requests to our own API (supertest) never use fetch.
function mockFetch(handler) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    sent.push({ url: String(url), init });
    return handler(String(url), init);
  });
}

describe('SSLCommerz and aamarPay adapters', () => {
  let user, massage;
  let dayOffset = 50;

  beforeAll(async () => {
    user = await registerUser('gw-real');
    massage = await findService('Swedish Massage');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    sent.length = 0;
  });

  const book = async () => {
    const res = await api()
      .post('/api/v1/appointments')
      .set(auth(user.token))
      .send({
        serviceId: massage.id,
        startTime: at(dateIn(dayOffset++), '11:00'),
        address: ADDRESS,
        paymentMethodId: await paymentMethodId('cash'),
      });
    return res.body.data;
  };
  const start = (id, provider) => api().post(`/api/v1/appointments/${id}/pay-online`).set(auth(user.token)).send({ provider });

  it('offers the configured gateways to customers', async () => {
    const res = await api().get('/api/v1/payment-methods').set(auth(user.token));
    expect(res.body.data.map((m) => m.code)).toEqual(expect.arrayContaining(['sslcommerz', 'aamarpay']));
  });

  it('aamarPay: starts a checkout for the exact amount and verifies it with the gateway', async () => {
    const booking = await book();
    mockFetch(() => json({ result: 'true', payment_url: 'https://sandbox.aamarpay.com/paynow.php?track=AAM1' }));
    const started = await start(booking.id, 'aamarpay');
    expect(started.status).toBe(201);
    expect(started.body.data.url).toBe('https://sandbox.aamarpay.com/paynow.php?track=AAM1');

    const body = JSON.parse(sent[0].init.body);
    expect(sent[0].url).toBe('https://sandbox.aamarpay.com/jsonpost.php');
    expect(body).toMatchObject({
      amount: '2500.00',
      currency: 'BDT',
      store_id: 'aamarpaytest',
      success_url: `https://api.example.test${GW}/aamarpay/success`,
    });
    const tranId = body.tran_id;

    // Wrong amount from the gateway => rejected.
    mockFetch(() => json({ pay_status: 'Successful', mer_txnid: tranId, amount_original: '10.00', bank_trxid: 'B1' }));
    const bad = await api().post(`${GW}/aamarpay/success`).type('form').send({ mer_txnid: tranId, pay_status: 'Successful' });
    expect(bad.text).toContain('not completed');
    expect((await prisma.appointment.findUnique({ where: { id: booking.id } })).paymentStatus).toBe('unpaid');

    // A fresh attempt that the gateway confirms for the right amount => paid.
    sent.length = 0;
    mockFetch(() => json({ result: 'true', payment_url: 'https://sandbox.aamarpay.com/paynow.php?track=AAM2' }));
    await start(booking.id, 'aamarpay');
    const tran2 = JSON.parse(sent[0].init.body).tran_id;
    mockFetch((url) => {
      expect(url).toContain('/api/v1/trxcheck/request.php');
      expect(url).toContain(`request_id=${tran2}`);
      return json({ pay_status: 'Successful', mer_txnid: tran2, amount_original: '2500.00', bank_trxid: 'BANK123' });
    });
    const ok = await api().post(`${GW}/aamarpay/success`).type('form').send({ mer_txnid: tran2, pay_status: 'Successful' });
    expect(ok.text).toContain('Payment received');
    expect(await prisma.appointment.findUnique({ where: { id: booking.id } })).toMatchObject({
      paymentStatus: 'paid',
      paymentReference: 'BANK123',
    });
  });

  it('aamarPay: a customer who only claims success in the browser is not trusted', async () => {
    const booking = await book();
    mockFetch(() => json({ result: 'true', payment_url: 'https://sandbox.aamarpay.com/paynow.php?track=AAM3' }));
    await start(booking.id, 'aamarpay');
    const tranId = JSON.parse(sent[0].init.body).tran_id;
    mockFetch(() => json({ pay_status: 'Failed', mer_txnid: tranId, amount_original: '2500.00' }));
    const res = await api().post(`${GW}/aamarpay/success`).type('form').send({ mer_txnid: tranId, pay_status: 'Successful' });
    expect(res.text).toContain('not completed');
    expect((await prisma.appointment.findUnique({ where: { id: booking.id } })).paymentStatus).toBe('unpaid');
  });

  it('SSLCommerz: starts a checkout, then validates the val_id with the gateway', async () => {
    const booking = await book();
    mockFetch(() =>
      json({ status: 'SUCCESS', GatewayPageURL: 'https://sandbox.sslcommerz.com/gwprocess/v4/gw.php?Q=PAY&SESSIONKEY=ABC' }),
    );
    const started = await start(booking.id, 'sslcommerz');
    expect(started.status).toBe(201);
    expect(started.body.data.url).toContain('sslcommerz.com');

    const form = new URLSearchParams(sent[0].init.body);
    expect(sent[0].url).toBe('https://sandbox.sslcommerz.com/gwprocess/v4/api.php');
    expect(form.get('total_amount')).toBe('2500.00');
    expect(form.get('currency')).toBe('BDT');
    expect(form.get('store_id')).toBe('testbox');
    expect(form.get('ipn_url')).toBe(`https://api.example.test${GW}/sslcommerz/ipn`);
    const tranId = form.get('tran_id');

    mockFetch((url) => {
      expect(url).toContain('validationserverAPI.php');
      expect(url).toContain('val_id=VAL1');
      return json({ status: 'VALID', tran_id: tranId, amount: '2500.00', bank_tran_id: 'BANK-SSL-1' });
    });
    // The IPN confirms the payment even if the customer's browser never returns.
    const ipn = await api().post(`${GW}/sslcommerz/ipn`).type('form').send({ tran_id: tranId, val_id: 'VAL1', status: 'VALID' });
    expect(ipn.status).toBe(200);
    expect(ipn.body.state).toBe('paid');
    expect(await prisma.appointment.findUnique({ where: { id: booking.id } })).toMatchObject({
      paymentStatus: 'paid',
      paymentReference: 'BANK-SSL-1',
    });

    // ...and the browser return afterwards is just a friendly page.
    const back = await api().post(`${GW}/sslcommerz/success`).type('form').send({ tran_id: tranId, val_id: 'VAL1' });
    expect(back.text).toContain('Payment received');
  });

  it('reports a gateway outage clearly and leaves the booking payable', async () => {
    const booking = await book();
    mockFetch(() => {
      throw new Error('network down');
    });
    const res = await start(booking.id, 'sslcommerz');
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('PAYMENT_GATEWAY_ERROR');
    expect((await prisma.appointment.findUnique({ where: { id: booking.id } })).paymentStatus).toBe('unpaid');
  });
});

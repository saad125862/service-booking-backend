import { beforeAll, describe, expect, it, vi } from 'vitest';

// Gemini is mocked: we test that the SERVER builds the payment link, with the booking's exact amount.
const gemini = vi.hoisted(() => ({ output: null }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: async () => ({ text: JSON.stringify(gemini.output) }) };
    }
  },
}));

process.env.GEMINI_API_KEY = 'test-key';
const { prisma } = await import('../src/db/prisma.js');
const { ADDRESS, api, at, auth, dateIn, findService, paymentMethodId, registerUser } = await import('./helpers.js');

const answer = (over) => ({
  language: 'en',
  reply: 'Sure, preparing it.',
  recommendedServiceIds: [],
  intent: 'pay_booking',
  discountServiceId: '',
  ...over,
});
const chat = (token, message) => api().post('/api/v1/ai/chat').set(auth(token)).send({ message });

describe('AI assistant: sends a payment link for the exact booking amount', () => {
  let customer, massage, booking;

  beforeAll(async () => {
    customer = await registerUser('ai-pay');
    massage = await findService('Swedish Massage'); // ৳2,500
  });

  it('says there is nothing to pay when the customer has no booking', async () => {
    gemini.output = answer({});
    const res = await chat(customer.token, 'payment link din');
    expect(res.status).toBe(200);
    expect(res.body.data.paymentLink).toBeNull();
    expect(res.body.data.reply).toContain('no booking');
  });

  it('creates a link for the upcoming unpaid booking, with the amount written by the server', async () => {
    const created = await api()
      .post('/api/v1/appointments')
      .set(auth(customer.token))
      .send({ serviceId: massage.id, startTime: at(dateIn(45), '14:00'), address: ADDRESS, paymentMethodId: await paymentMethodId('cash') });
    booking = created.body.data;
    await prisma.appointment.update({ where: { id: booking.id }, data: { price: 2000, discountAmount: 500 } });

    gemini.output = answer({ reply: 'Pay ৳99 at http://evil.example/pay' }); // the model's own text must not be used
    const res = await chat(customer.token, 'I want to pay');
    const link = res.body.data.paymentLink;
    expect(link).toMatchObject({ appointmentId: booking.id, serviceName: 'Swedish Massage', amount: 2000, provider: 'mock' });
    expect(link.url).toContain('/payments/gateway/mock/checkout/');
    expect(res.body.data.reply).toContain('৳2,000');
    expect(res.body.data.reply).not.toContain('evil.example');
    expect(res.body.data.recommendedServices).toEqual([]);
  });

  it('replies in Bangla and Banglish with the same link logic', async () => {
    gemini.output = answer({ language: 'bn' });
    const bn = await chat(customer.token, 'আমি পেমেন্ট করব');
    expect(bn.body.data.paymentLink.amount).toBe(2000);
    expect(bn.body.data.reply).toContain('পেমেন্ট লিংক');

    gemini.output = answer({ language: 'banglish' });
    const bl = await chat(customer.token, 'payment korbo');
    expect(bl.body.data.reply).toContain('payment link');
  });

  it('after paying, there is nothing left to pay', async () => {
    await prisma.appointment.update({ where: { id: booking.id }, data: { paymentStatus: 'paid' } });
    gemini.output = answer({});
    const res = await chat(customer.token, 'pay now');
    expect(res.body.data.paymentLink).toBeNull();
  });

  it('other intents never return a link', async () => {
    gemini.output = answer({ intent: 'none', reply: 'Swedish Massage costs ৳2,500.' });
    const res = await chat(customer.token, 'how much is a massage?');
    expect(res.body.data.paymentLink).toBeNull();
  });
});

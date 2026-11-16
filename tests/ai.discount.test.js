import { beforeAll, describe, expect, it, vi } from 'vitest';

// Gemini is mocked: we only test what the server does with the assistant's structured answer.
const gemini = vi.hoisted(() => ({ output: null }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    constructor() {
      this.models = { generateContent: async () => ({ text: JSON.stringify(gemini.output) }) };
    }
  },
}));

process.env.GEMINI_API_KEY = 'test-key'; // must be set before the app (and its env validation) loads
const { prisma } = await import('../src/db/prisma.js');
const { api, auth, findService, registerUser } = await import('./helpers.js');

const answer = (over) => ({
  language: 'en',
  reply: 'I have passed your request to an admin who is reviewing it.',
  recommendedServiceIds: [],
  intent: 'discount_request',
  discountServiceId: '',
  ...over,
});
const chat = (token, message) => api().post('/api/v1/ai/chat').set(auth(token)).send({ message });

describe('AI assistant: discount requests wait for an admin', () => {
  let customer, massage;

  beforeAll(async () => {
    customer = await registerUser('ai-disc');
    massage = await findService('Swedish Massage');
  });

  it('turns a discount ask into a pending request for the right service, without granting anything', async () => {
    gemini.output = answer({ discountServiceId: massage.id });
    const res = await chat(customer.token, 'Can I get a discount on the Swedish massage?');
    expect(res.status).toBe(200);
    expect(res.body.data.reply).toContain('admin');
    expect(res.body.data.discountRequest).toMatchObject({ status: 'pending', created: true });

    const stored = await prisma.discountRequest.findFirst({ where: { userId: customer.id } });
    expect(stored).toMatchObject({ status: 'pending', serviceId: massage.id, language: 'en' });
    expect(stored.discountValue).toBeNull(); // the AI never sets an amount
  });

  it('asking again returns the same open request instead of piling up duplicates', async () => {
    gemini.output = answer({ discountServiceId: massage.id });
    const res = await chat(customer.token, 'Please, any discount?');
    expect(res.body.data.discountRequest.created).toBe(false);
    expect(await prisma.discountRequest.count({ where: { userId: customer.id } })).toBe(1);
  });

  it('ignores an invented service id and records the language of the request', async () => {
    const other = await registerUser('ai-disc2');
    gemini.output = answer({ language: 'banglish', discountServiceId: '11111111-1111-4111-8111-111111111111' });
    const res = await chat(other.token, 'amake ektu discount dite parben?');
    expect(res.body.data.discountRequest.created).toBe(true);
    const stored = await prisma.discountRequest.findFirst({ where: { userId: other.id } });
    expect(stored).toMatchObject({ serviceId: null, language: 'banglish' });
  });

  it('creates nothing for ordinary questions or when an admin chats', async () => {
    const plain = await registerUser('ai-disc3');
    gemini.output = answer({ intent: 'none', reply: 'Swedish Massage costs ৳2,500.' });
    const res = await chat(plain.token, 'How much is the massage?');
    expect(res.body.data.discountRequest).toBeNull();
    expect(await prisma.discountRequest.count({ where: { userId: plain.id } })).toBe(0);

    const admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
    gemini.output = answer({ discountServiceId: massage.id });
    const asAdmin = await chat(admin.token, 'discount?');
    expect(asAdmin.body.data.discountRequest).toBeNull();
    expect(await prisma.discountRequest.count({ where: { userId: admin.user.id } })).toBe(0);
  });
});

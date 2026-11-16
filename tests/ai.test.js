import { describe, expect, it } from 'vitest';
import { api, auth, registerUser } from './helpers.js';

// These tests never reach Gemini (no key is configured in the test environment).
describe('AI assistant endpoint', () => {
  it('requires authentication', async () => {
    expect((await api().post('/api/v1/ai/chat').send({ message: 'hi' })).status).toBe(401);
  });

  it('validates the message and history', async () => {
    const { token } = await registerUser('ai-validate');
    const post = (body) => api().post('/api/v1/ai/chat').set(auth(token)).send(body);

    expect((await post({ message: '   ' })).status).toBe(400);
    expect((await post({ message: 'x'.repeat(501) })).status).toBe(400);
    const history = Array.from({ length: 11 }, () => ({ role: 'user', content: 'a' }));
    expect((await post({ message: 'hi', history })).status).toBe(400);
    expect((await post({ message: 'hi', history: [{ role: 'system', content: 'a' }] })).status).toBe(400);
  });

  it('reports a clear 503 when no API key is configured', async () => {
    const { token } = await registerUser('ai-nokey');
    const res = await api().post('/api/v1/ai/chat').set(auth(token)).send({ message: 'hello' });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('AI_NOT_CONFIGURED');
  });
});

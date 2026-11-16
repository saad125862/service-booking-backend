import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/db/prisma.js';
import { api, auth, registerUser } from './helpers.js';

// A 1x1 transparent PNG, the smallest honest test image.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 1)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(8)]);

describe('service photo uploads', () => {
  let admin, customer;
  const created = [];

  beforeAll(async () => {
    customer = await registerUser('media');
    admin = (await api().post('/api/v1/auth/login').send({ email: 'admin@example.com', password: 'Admin@1234' })).body.data;
  });
  afterAll(async () => {
    await prisma.media.deleteMany({ where: { id: { in: created } } });
  });

  const upload = (token, body, type = 'image/png') => {
    const req = api().post('/api/v1/admin/uploads/image');
    if (token) req.set(auth(token));
    return req.set('Content-Type', type).send(body);
  };

  it('only admins can upload', async () => {
    expect((await upload(null, PNG)).status).toBe(401);
    expect((await upload(customer.token, PNG)).status).toBe(403);
  });

  it('stores a photo and serves it publicly with the right headers', async () => {
    const res = await upload(admin.token, PNG);
    expect(res.status).toBe(201);
    const { id, url, mimeType, sizeBytes } = res.body.data;
    created.push(id);
    expect(mimeType).toBe('image/png');
    expect(sizeBytes).toBe(PNG.length);
    expect(url).toMatch(new RegExp(`/api/v1/media/${id}$`));

    // No login needed to view it, and the web app (another origin) is allowed to embed it.
    const got = await api().get(`/api/v1/media/${id}`).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toBe('image/png');
    expect(got.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(got.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(got.body, PNG)).toBe(0);
  });

  it('accepts JPEG and WebP too', async () => {
    for (const [buf, type] of [[JPEG, 'image/jpeg'], [WEBP, 'image/webp']]) {
      const res = await upload(admin.token, buf, type);
      expect(res.status).toBe(201);
      expect(res.body.data.mimeType).toBe(type);
      created.push(res.body.data.id);
    }
  });

  it('checks the real file type, not the label', async () => {
    const fake = await upload(admin.token, Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(fake.status).toBe(415);
    expect(fake.body.error.code).toBe('UNSUPPORTED_FILE');

    const mislabelled = await upload(admin.token, JPEG, 'image/png'); // a JPEG is fine under any image label
    expect(mislabelled.status).toBe(201);
    expect(mislabelled.body.data.mimeType).toBe('image/jpeg');
    created.push(mislabelled.body.data.id);

    const pdf = await upload(admin.token, Buffer.from('%PDF-1.4'), 'application/pdf');
    expect(pdf.status).toBe(415);
  });

  it('rejects an empty or oversized file', async () => {
    expect((await upload(admin.token, Buffer.alloc(0))).status).toBe(400);
    const big = Buffer.concat([JPEG, Buffer.alloc(5 * 1024 * 1024)]);
    const res = await upload(admin.token, big, 'image/jpeg');
    expect(res.status).toBe(413);
    expect(res.body.error.message).toContain('5 MB');
  });

  it('answers 404 for an unknown photo and 400 for a malformed id', async () => {
    expect((await api().get('/api/v1/media/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await api().get('/api/v1/media/not-an-id')).status).toBe(400);
  });

  it('a service can use the uploaded photo as its picture', async () => {
    const up = await upload(admin.token, PNG);
    created.push(up.body.data.id);
    const make = await api()
      .post('/api/v1/admin/services')
      .set(auth(admin.token))
      .send({
        name: `Photo test ${Date.now()}`,
        description: 'A service created to test photo uploads.',
        price: 100,
        durationMinutes: 30,
        category: 'Testing',
        imageUrl: up.body.data.url,
      });
    expect(make.status).toBe(201);
    expect(make.body.data.imageUrl).toBe(up.body.data.url);
    await prisma.service.delete({ where: { id: make.body.data.id } });
  });
});

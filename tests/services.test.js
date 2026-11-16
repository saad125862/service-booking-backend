import { describe, expect, it } from 'vitest';
import { api } from './helpers.js';

describe('services catalog', () => {
  it('lists seeded services with pagination meta, featured first', async () => {
    const res = await api().get('/api/v1/services').query({ limit: 5 });
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.meta).toMatchObject({ page: 1, limit: 5 });
    expect(res.body.meta.total).toBeGreaterThanOrEqual(14);
    expect(res.body.data[0].isFeatured).toBe(true);
    expect(typeof res.body.data[0].price).toBe('number');
  });

  it('filters by search, category, featured and price, and sorts', async () => {
    const search = await api().get('/api/v1/services').query({ search: 'massage' });
    expect(search.body.data.length).toBeGreaterThan(0);

    const beauty = await api().get('/api/v1/services').query({ category: 'beauty', maxPrice: 45, sort: 'price_asc' });
    const prices = beauty.body.data.map((s) => s.price);
    expect(beauty.body.data.every((s) => s.category === 'Beauty' && s.price <= 45)).toBe(true);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));

    const featured = await api().get('/api/v1/services').query({ featured: 'true' });
    expect(featured.body.data.every((s) => s.isFeatured)).toBe(true);
  });

  it('treats % and _ in search text literally (no wildcard injection)', async () => {
    for (const term of ['%', '_']) {
      const res = await api().get('/api/v1/services').query({ search: term });
      expect(res.body.meta.total).toBe(0);
    }
  });

  it('rejects bad query params and unknown ids', async () => {
    expect((await api().get('/api/v1/services').query({ sort: 'drop table' })).status).toBe(400);
    expect((await api().get('/api/v1/services').query({ minPrice: 50, maxPrice: 10 })).status).toBe(400);
    expect((await api().get('/api/v1/services/not-a-uuid')).status).toBe(400);
    expect((await api().get('/api/v1/services/00000000-0000-4000-8000-000000000000')).status).toBe(404);
  });

  it('lists categories with counts', async () => {
    const res = await api().get('/api/v1/services/categories');
    expect(res.body.data.map((c) => c.name)).toEqual(expect.arrayContaining(['Beauty', 'Wellness', 'Fitness']));
  });
});

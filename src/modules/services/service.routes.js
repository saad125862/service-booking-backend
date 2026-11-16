import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/pool.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

const toService = (r) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  price: Number(r.price),
  durationMinutes: r.duration_minutes,
  imageUrl: r.image_url,
  category: r.category,
  isFeatured: r.is_featured,
  bookingsCount: Number(r.bookings_count ?? 0),
});

// Each value maps to a fixed SQL fragment, so user input never reaches ORDER BY.
const SORTS = {
  featured: 's.is_featured DESC, bookings_count DESC, s.name ASC',
  popular: 'bookings_count DESC, s.is_featured DESC, s.name ASC',
  price_asc: 's.price ASC, s.name ASC',
  price_desc: 's.price DESC, s.name ASC',
  name: 's.name ASC',
  newest: 's.created_at DESC, s.name ASC',
};

const listQuery = z
  .object({
    search: z.string().trim().max(100).optional(),
    category: z.string().trim().max(60).optional(),
    featured: z.enum(['true', 'false']).optional(),
    minPrice: z.coerce.number().min(0).optional(),
    maxPrice: z.coerce.number().min(0).optional(),
    sort: z.enum(Object.keys(SORTS)).default('featured'),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .refine((q) => q.minPrice === undefined || q.maxPrice === undefined || q.minPrice <= q.maxPrice, {
    message: 'minPrice must be less than or equal to maxPrice',
    path: ['minPrice'],
  });

const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');

const BOOKINGS_COUNT = `(SELECT count(*) FROM appointments a
                          WHERE a.service_id = s.id AND a.status <> 'cancelled') AS bookings_count`;

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { search, category, featured, minPrice, maxPrice, sort, page, limit } = req.valid.query;

  const where = ['s.is_active'];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replaceAll('?', `$${params.length}`));
  };

  if (search) add(`(s.name ILIKE ? OR s.description ILIKE ? OR s.category ILIKE ?)`, `%${escapeLike(search)}%`);
  if (category) add(`s.category ILIKE ?`, escapeLike(category));
  if (featured) add(`s.is_featured = ?`, featured === 'true');
  if (minPrice !== undefined) add(`s.price >= ?`, minPrice);
  if (maxPrice !== undefined) add(`s.price <= ?`, maxPrice);

  const whereSql = where.join(' AND ');
  const total = Number(
    (await query(`SELECT count(*) FROM services s WHERE ${whereSql}`, params)).rows[0].count,
  );

  const { rows } = await query(
    `SELECT s.*, ${BOOKINGS_COUNT}
       FROM services s
      WHERE ${whereSql}
      ORDER BY ${SORTS[sort]}
      LIMIT ${limit} OFFSET ${(page - 1) * limit}`,
    params,
  );

  ok(res, rows.map(toService), { page, limit, total, totalPages: Math.ceil(total / limit) });
});

router.get('/categories', async (_req, res) => {
  const { rows } = await query(
    `SELECT category AS name, count(*)::int AS count
       FROM services WHERE is_active GROUP BY category ORDER BY category`,
  );
  ok(res, rows);
});

router.get('/:id', validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  const { rows } = await query(
    `SELECT s.*, ${BOOKINGS_COUNT} FROM services s WHERE s.id = $1 AND s.is_active`,
    [req.valid.params.id],
  );
  if (!rows[0]) throw ApiError.notFound('Service not found');
  ok(res, toService(rows[0]));
});

export default router;

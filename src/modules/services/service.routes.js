import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';

const router = Router();

const toService = (s) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  price: Number(s.price),
  durationMinutes: s.durationMinutes,
  imageUrl: s.imageUrl,
  category: s.category,
  isFeatured: s.isFeatured,
  bookingsCount: s._count?.appointments ?? 0, // how many times the service has been booked
});

const withCount = { _count: { select: { appointments: true } } };

// Each key maps to a fixed Prisma orderBy, so user input never builds the sort.
const SORTS = {
  featured: [{ isFeatured: 'desc' }, { appointments: { _count: 'desc' } }, { name: 'asc' }],
  popular: [{ appointments: { _count: 'desc' } }, { isFeatured: 'desc' }, { name: 'asc' }],
  price_asc: [{ price: 'asc' }, { name: 'asc' }],
  price_desc: [{ price: 'desc' }, { name: 'asc' }],
  name: [{ name: 'asc' }],
  newest: [{ createdAt: 'desc' }, { name: 'asc' }],
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

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { search, category, featured, minPrice, maxPrice, sort, page, limit } = req.valid.query;
  // Prisma passes "contains"/insensitive "equals" to LIKE/ILIKE without escaping wildcards,
  // so a literal % or _ typed by a user must be escaped here.
  const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
  const insensitive = (v) => ({ contains: escapeLike(v), mode: 'insensitive' });

  const where = {
    isActive: true,
    ...(search && {
      OR: [{ name: insensitive(search) }, { description: insensitive(search) }, { category: insensitive(search) }],
    }),
    ...(category && { category: { equals: escapeLike(category), mode: 'insensitive' } }),
    ...(featured && { isFeatured: featured === 'true' }),
    ...((minPrice !== undefined || maxPrice !== undefined) && {
      price: {
        ...(minPrice !== undefined && { gte: minPrice }),
        ...(maxPrice !== undefined && { lte: maxPrice }),
      },
    }),
  };

  const [total, rows] = await Promise.all([
    prisma.service.count({ where }),
    prisma.service.findMany({
      where,
      orderBy: SORTS[sort],
      skip: (page - 1) * limit,
      take: limit,
      include: withCount,
    }),
  ]);

  ok(res, rows.map(toService), { page, limit, total, totalPages: Math.ceil(total / limit) });
});

router.get('/categories', async (_req, res) => {
  const groups = await prisma.service.groupBy({
    by: ['category'],
    where: { isActive: true },
    _count: { _all: true },
    orderBy: { category: 'asc' },
  });
  ok(res, groups.map((g) => ({ name: g.category, count: g._count._all })));
});

router.get('/:id', validate({ params: z.object({ id: z.uuid() }) }), async (req, res) => {
  const service = await prisma.service.findFirst({
    where: { id: req.valid.params.id, isActive: true },
    include: withCount,
  });
  if (!service) throw ApiError.notFound('Service not found');
  ok(res, toService(service));
});

export default router;

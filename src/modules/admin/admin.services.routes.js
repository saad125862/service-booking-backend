import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { created, ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';
import { loadFieldDefs, validateAttributes } from '../services/attributes.js';
import { toService, withBookingCount } from '../services/service.mapper.js';

// Admin service management: add, edit, deactivate. The form is dynamic: besides the fixed
// fields, `attributes` carries values for the custom fields admins define (see admin.fields).

const router = Router();

const imageUrl = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), 'Image must be an http(s) URL')
  .or(z.literal(''))
  .nullable()
  .optional();

// Field rules without defaults: a PATCH must only change what it sends. Defaults (used when
// creating) are added on top for the create body only.
const fields = {
  name: z.string().trim().min(2, 'Name must be at least 2 characters').max(120),
  description: z.string().trim().min(10, 'Describe the service in at least 10 characters').max(2000),
  price: z.coerce.number().min(0, 'Price cannot be negative').max(10_000_000),
  durationMinutes: z.coerce.number().int().min(5, 'At least 5 minutes').max(480, 'At most 480 minutes'),
  category: z.string().trim().min(2).max(60),
  imageUrl,
  isFeatured: z.boolean(),
  isActive: z.boolean(),
  attributes: z.record(z.string(), z.unknown()),
};

const serviceBody = z.object({
  ...fields,
  isFeatured: fields.isFeatured.default(false),
  isActive: fields.isActive.default(true),
  attributes: fields.attributes.default({}),
});

const updateBody = z
  .object(fields)
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

const idParams = z.object({ id: z.uuid() });

const listQuery = z.object({
  search: z.string().trim().max(100).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('all'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const nameTaken = (err) => err?.code === 'P2002' && ApiError.conflict('SERVICE_NAME_TAKEN', 'A service with this name already exists');

router.get('/', validate({ query: listQuery }), async (req, res) => {
  const { search, status, page, limit } = req.valid.query;
  const where = {
    ...(status !== 'all' && { isActive: status === 'active' }),
    ...(search && {
      OR: [
        { name: { contains: search, mode: 'insensitive' } },
        { category: { contains: search, mode: 'insensitive' } },
      ],
    }),
  };
  const [total, rows] = await Promise.all([
    prisma.service.count({ where }),
    prisma.service.findMany({
      where,
      include: withBookingCount,
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  ok(res, rows.map((s) => toService(s, { admin: true })), { page, limit, total, totalPages: Math.ceil(total / limit) });
});

router.get('/:id', validate({ params: idParams }), async (req, res) => {
  const service = await prisma.service.findUnique({ where: { id: req.valid.params.id }, include: withBookingCount });
  if (!service) throw ApiError.notFound('Service not found');
  ok(res, toService(service, { admin: true, defs: await loadFieldDefs() }));
});

router.post('/', validate({ body: serviceBody }), async (req, res) => {
  const { attributes, imageUrl: image, ...rest } = req.valid.body;
  const cleaned = validateAttributes(attributes, await loadFieldDefs());
  try {
    const service = await prisma.service.create({
      data: { ...rest, imageUrl: image || null, attributes: cleaned },
      include: withBookingCount,
    });
    created(res, toService(service, { admin: true, defs: await loadFieldDefs() }));
  } catch (err) {
    throw nameTaken(err) || err;
  }
});

router.patch('/:id', validate({ params: idParams, body: updateBody }), async (req, res) => {
  const { attributes, imageUrl: image, ...rest } = req.valid.body;
  const data = { ...rest };
  if (image !== undefined) data.imageUrl = image || null;
  // When attributes are sent they replace the stored set, validated against the current fields.
  if (attributes !== undefined) data.attributes = validateAttributes(attributes, await loadFieldDefs());

  try {
    const service = await prisma.service.update({
      where: { id: req.valid.params.id },
      data,
      include: withBookingCount,
    });
    ok(res, toService(service, { admin: true, defs: await loadFieldDefs() }));
  } catch (err) {
    if (err?.code === 'P2025') throw ApiError.notFound('Service not found');
    throw nameTaken(err) || err;
  }
});

// Services are never hard-deleted: past bookings and sales reports still refer to them.
// "Deleting" hides the service from customers; PATCH isActive:true brings it back.
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  try {
    const service = await prisma.service.update({
      where: { id: req.valid.params.id },
      data: { isActive: false },
      include: withBookingCount,
    });
    ok(res, toService(service, { admin: true }));
  } catch (err) {
    if (err?.code === 'P2025') throw ApiError.notFound('Service not found');
    throw err;
  }
});

export default router;

import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { created, ok } from '../../utils/response.js';
import { validate } from '../../middleware/validate.js';
import { loadFieldDefs, toFieldDef } from '../services/attributes.js';

// Definitions of the extra fields on the add/edit service form ("dynamic form").
// Admins can add a field whenever the standard form is not enough; it then shows up on the
// form for every service, and its value is shown to customers on the service page.

const router = Router();

const TYPES = ['text', 'textarea', 'number', 'boolean', 'select'];

const slug = (label) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);

const options = z
  .array(z.string().trim().min(1).max(60))
  .min(1, 'Add at least one option')
  .max(30)
  .refine((o) => new Set(o).size === o.length, 'Options must be unique');

const createBody = z
  .object({
    label: z.string().trim().min(2, 'Label must be at least 2 characters').max(80),
    key: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, 'Use lower-case letters, numbers and underscores')
      .optional(),
    type: z.enum(TYPES),
    options: options.optional(),
    required: z.boolean().default(false),
    sortOrder: z.coerce.number().int().min(0).max(1000).default(0),
  })
  .refine((b) => b.type !== 'select' || b.options, { message: 'A dropdown needs options', path: ['options'] });

const updateBody = z
  .object({
    label: z.string().trim().min(2).max(80),
    options,
    required: z.boolean(),
    sortOrder: z.coerce.number().int().min(0).max(1000),
    isActive: z.boolean(),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, { message: 'Provide at least one field to update' });

const idParams = z.object({ id: z.uuid() });

router.get('/', async (_req, res) => {
  ok(res, (await loadFieldDefs({ includeInactive: true })).map(toFieldDef));
});

router.post('/', validate({ body: createBody }), async (req, res) => {
  const { key, options: opts, ...rest } = req.valid.body;
  const finalKey = key ?? slug(rest.label);
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(finalKey)) {
    throw ApiError.validation([{ field: 'key', message: 'Could not build a key from the label; enter one' }]);
  }
  try {
    const field = await prisma.serviceField.create({
      data: { ...rest, key: finalKey, options: rest.type === 'select' ? opts : undefined },
    });
    created(res, toFieldDef(field));
  } catch (err) {
    if (err?.code === 'P2002') throw ApiError.conflict('FIELD_KEY_TAKEN', `A field with the key "${finalKey}" already exists`);
    throw err;
  }
});

// The key and type are fixed once created (existing values depend on them).
router.patch('/:id', validate({ params: idParams, body: updateBody }), async (req, res) => {
  const { options: opts, ...rest } = req.valid.body;
  const existing = await prisma.serviceField.findUnique({ where: { id: req.valid.params.id } });
  if (!existing) throw ApiError.notFound('Field not found');
  if (opts && existing.type !== 'select') {
    throw ApiError.validation([{ field: 'options', message: 'Only dropdown fields have options' }]);
  }
  const field = await prisma.serviceField.update({
    where: { id: existing.id },
    data: { ...rest, ...(opts && { options: opts }) },
  });
  ok(res, toFieldDef(field));
});

// Fields are deactivated, not deleted: stored values stay in the data and come back if re-enabled.
router.delete('/:id', validate({ params: idParams }), async (req, res) => {
  try {
    ok(res, toFieldDef(await prisma.serviceField.update({ where: { id: req.valid.params.id }, data: { isActive: false } })));
  } catch (err) {
    if (err?.code === 'P2025') throw ApiError.notFound('Field not found');
    throw err;
  }
});

export default router;

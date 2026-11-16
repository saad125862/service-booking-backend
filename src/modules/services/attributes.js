import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';

// The admin-defined custom fields ("dynamic form"). Their values live in services.attributes.

export const loadFieldDefs = ({ includeInactive = false } = {}) =>
  prisma.serviceField.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

function coerce(def, value) {
  switch (def.type) {
    case 'text': {
      const v = String(value).trim();
      return v.length <= 200 ? v : { error: 'Must be at most 200 characters' };
    }
    case 'textarea': {
      const v = String(value).trim();
      return v.length <= 2000 ? v : { error: 'Must be at most 2000 characters' };
    }
    case 'number': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      return Number.isFinite(n) ? n : { error: 'Must be a number' };
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value;
      if (value === 'true') return true;
      if (value === 'false') return false;
      return { error: 'Must be true or false' };
    }
    case 'select': {
      const options = Array.isArray(def.options) ? def.options : [];
      const v = String(value);
      return options.includes(v) ? v : { error: `Must be one of: ${options.join(', ')}` };
    }
    default:
      return { error: 'Unsupported field type' };
  }
}

/**
 * Validates submitted attribute values against the active field definitions and returns the
 * cleaned object to store. Unknown keys, wrong types, bad select options and missing required
 * fields are reported together as a 400 VALIDATION_ERROR with per-field details.
 */
export function validateAttributes(input, defs) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const known = new Map(defs.map((d) => [d.key, d]));
  const errors = [];
  const out = {};

  for (const key of Object.keys(source)) {
    if (!known.has(key)) errors.push({ field: `attributes.${key}`, message: 'Unknown field' });
  }
  for (const def of defs) {
    const raw = source[def.key];
    if (isEmpty(raw)) {
      if (def.required) errors.push({ field: `attributes.${def.key}`, message: `${def.label} is required` });
      continue;
    }
    const result = coerce(def, raw);
    if (result !== null && typeof result === 'object' && 'error' in result) {
      errors.push({ field: `attributes.${def.key}`, message: `${def.label}: ${result.error}` });
    } else {
      out[def.key] = result;
    }
  }
  if (errors.length > 0) throw ApiError.validation(errors);
  return out;
}

/** Stored values -> display list for customers: only active fields that have a value. */
export const expandAttributes = (raw, defs) =>
  defs
    .filter((d) => raw && raw[d.key] !== undefined && raw[d.key] !== null && raw[d.key] !== '')
    .map((d) => ({ key: d.key, label: d.label, type: d.type, value: raw[d.key] }));

export const toFieldDef = (d) => ({
  id: d.id,
  key: d.key,
  label: d.label,
  type: d.type,
  options: Array.isArray(d.options) ? d.options : [],
  required: d.required,
  sortOrder: d.sortOrder,
  isActive: d.isActive,
});

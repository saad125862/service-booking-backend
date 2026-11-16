import { expandAttributes } from './attributes.js';

export const withBookingCount = { _count: { select: { appointments: true } } };

/**
 * Shapes a service for API responses.
 * - `defs` (active custom fields) adds the customer-facing `attributes` list (details screens).
 * - `admin: true` adds the fields only admins need (status and the raw attribute values).
 */
export const toService = (s, { defs, admin = false } = {}) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  price: Number(s.price),
  durationMinutes: s.durationMinutes,
  imageUrl: s.imageUrl,
  category: s.category,
  isFeatured: s.isFeatured,
  bookingsCount: s._count?.appointments ?? 0, // how many times the service has been booked
  ...(defs && { attributes: expandAttributes(s.attributes, defs) }),
  ...(admin && { isActive: s.isActive, attributeValues: s.attributes ?? {}, createdAt: s.createdAt }),
});

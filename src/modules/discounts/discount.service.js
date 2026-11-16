import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { notify, notifyAdmins } from '../notifications/notification.service.js';
import { composeDecisionReply } from './discount.reply.js';

// Discount requests: a customer asks the AI assistant for a discount, an admin approves
// (percent or fixed BDT amount) or declines, and the assistant answers the customer.
// An approved discount belongs to that customer only and is used by ONE booking: it is
// consumed when that booking is made, later bookings pay the current price, and it is
// given back if that booking is cancelled before the service.

export const MAX_PERCENT = 90;
const DEFAULT_VALID_DAYS = 14;

const round2 = (n) => Math.round(n * 100) / 100;
const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

const include = {
  service: { select: { id: true, name: true, price: true } },
  user: { select: { id: true, name: true, email: true } },
};

// "approved" past its expiry is shown as "expired" (not stored, derived on read).
export const effectiveStatus = (r) =>
  r.status === 'approved' && r.expiresAt && r.expiresAt <= new Date() ? 'expired' : r.status;

export const toDiscountRequest = (r, { admin = false } = {}) => ({
  id: r.id,
  status: effectiveStatus(r),
  message: r.message,
  language: r.language,
  service: r.service ? { id: r.service.id, name: r.service.name, price: Number(r.service.price) } : null,
  discountType: r.discountType,
  discountValue: r.discountValue === null ? null : Number(r.discountValue),
  reply: r.reply,
  decidedAt: r.decidedAt,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  ...(admin && {
    adminNote: r.adminNote,
    usedAppointmentId: r.usedAppointmentId,
    customer: r.user ? { id: r.user.id, name: r.user.name, email: r.user.email } : null,
  }),
});

/** Amount (BDT) a request takes off a given price, never more than the price itself. */
export function discountAmountFor(request, price) {
  const p = Number(price);
  const v = Number(request.discountValue);
  const raw = request.discountType === 'percent' ? (p * v) / 100 : v;
  return Math.min(round2(raw), p);
}

/** Called by the AI assistant. One open request per customer and service: asking again returns it. */
export async function createDiscountRequest(userId, { serviceId, message, language }) {
  const existing = await prisma.discountRequest.findFirst({
    where: { userId, status: 'pending', serviceId: serviceId ?? null },
    include,
  });
  if (existing) return { request: existing, created: false };

  const request = await prisma.discountRequest.create({
    data: {
      userId,
      serviceId: serviceId ?? null,
      message: clip(message, 500),
      language: ['en', 'bn', 'banglish'].includes(language) ? language : 'en',
    },
    include,
  });
  await notifyAdmins({
    type: 'discount_request',
    title: 'Discount request',
    body: `${request.user.name} asked for a discount${request.service ? ` on ${request.service.name}` : ''}: "${clip(message, 200)}"`,
    data: { discountRequestId: request.id },
  });
  return { request, created: true };
}

export async function listMyDiscountRequests(userId) {
  const rows = await prisma.discountRequest.findMany({
    where: { userId },
    include,
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  return rows.map((r) => toDiscountRequest(r));
}

export async function listDiscountRequestsForAdmin({ status, page, limit }) {
  const where = status ? { status } : {};
  const [total, rows] = await Promise.all([
    prisma.discountRequest.count({ where }),
    prisma.discountRequest.findMany({
      where,
      include,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map((r) => toDiscountRequest(r, { admin: true })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

async function loadPending(id) {
  const request = await prisma.discountRequest.findUnique({ where: { id }, include });
  if (!request) throw ApiError.notFound('Discount request not found');
  if (request.status !== 'pending') {
    throw ApiError.conflict('NOT_PENDING', 'This request has already been decided');
  }
  return request;
}

export async function approveDiscountRequest(id, adminId, { type, value, expiresInDays = DEFAULT_VALID_DAYS, note }) {
  const request = await loadPending(id);

  if (type === 'percent' && (value < 1 || value > MAX_PERCENT)) {
    throw ApiError.validation([{ field: 'value', message: `Percent must be between 1 and ${MAX_PERCENT}` }]);
  }
  if (type === 'fixed' && request.service && value > Number(request.service.price)) {
    throw ApiError.validation([{ field: 'value', message: 'The amount cannot be more than the service price' }]);
  }

  const expiresAt = new Date(Date.now() + expiresInDays * 86_400_000);
  const reply = await composeDecisionReply({
    language: request.language,
    decision: 'approved',
    serviceName: request.service?.name,
    type,
    value,
    expiresAt,
    note,
    tz: env.BUSINESS_TZ,
  });

  // Conditional update: two admins deciding at once cannot both win.
  const { count } = await prisma.discountRequest.updateMany({
    where: { id, status: 'pending' },
    data: {
      status: 'approved',
      discountType: type,
      discountValue: value,
      adminNote: note ?? null,
      reply,
      decidedBy: adminId,
      decidedAt: new Date(),
      expiresAt,
    },
  });
  if (count === 0) throw ApiError.conflict('NOT_PENDING', 'This request has already been decided');

  await notify(request.userId, {
    type: 'discount_approved',
    title: 'Discount approved',
    body: reply,
    data: { discountRequestId: id, serviceId: request.serviceId },
  });
  return toDiscountRequest(await prisma.discountRequest.findUnique({ where: { id }, include }), { admin: true });
}

export async function declineDiscountRequest(id, adminId, { note }) {
  const request = await loadPending(id);
  const reply = await composeDecisionReply({
    language: request.language,
    decision: 'declined',
    serviceName: request.service?.name,
    note,
    tz: env.BUSINESS_TZ,
  });

  const { count } = await prisma.discountRequest.updateMany({
    where: { id, status: 'pending' },
    data: { status: 'declined', adminNote: note ?? null, reply, decidedBy: adminId, decidedAt: new Date() },
  });
  if (count === 0) throw ApiError.conflict('NOT_PENDING', 'This request has already been decided');

  await notify(request.userId, {
    type: 'discount_declined',
    title: 'Discount request update',
    body: reply,
    data: { discountRequestId: id, serviceId: request.serviceId },
  });
  return toDiscountRequest(await prisma.discountRequest.findUnique({ where: { id }, include }), { admin: true });
}

/**
 * The best approved, unexpired, unused discount this customer has for the service
 * (one for that service or a general one). `db` is a Prisma client or transaction.
 */
export async function findApplicableDiscount(db, userId, serviceId, servicePrice) {
  const now = new Date();
  const candidates = await db.discountRequest.findMany({
    where: {
      userId,
      status: 'approved',
      AND: [{ OR: [{ serviceId }, { serviceId: null }] }, { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
  });
  let best = null;
  for (const request of candidates) {
    const amount = discountAmountFor(request, servicePrice);
    if (amount > 0 && (!best || amount > best.amount)) best = { request, amount };
  }
  return best;
}

/** A cancelled booking gives its one-time discount back (still subject to its expiry). */
export const restoreDiscountForAppointment = (db, appointmentId) =>
  db.discountRequest.updateMany({
    where: { usedAppointmentId: appointmentId, status: 'used' },
    data: { status: 'approved', usedAppointmentId: null },
  });

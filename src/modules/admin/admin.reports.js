import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { env } from '../../config/env.js';
import { ok } from '../../utils/response.js';
import { addDays, localDateString, zonedToUtcMs } from '../../utils/time.js';
import { validate } from '../../middleware/validate.js';
import { toAdminAppointment } from './admin.appointments.routes.js';

// Dashboard and sales reports.
//
// Definitions (documented in the API docs too):
//   Sales / revenue = the booked price (after discounts) of bookings that are CONFIRMED or COMPLETED,
//                     dated by the service date in the business time zone.
//   Pipeline        = price of bookings still PENDING (not counted as sales yet).
// Aggregation is done in JavaScript over the selected date range, which keeps the code simple and
// timezone-correct; at larger scale it would move into SQL GROUP BY queries.

const SOLD = ['confirmed', 'completed'];
const num = (d) => Number(d ?? 0);
const round2 = (n) => Math.round(n * 100) / 100;
const sum = (rows, pick) => round2(rows.reduce((t, r) => t + pick(r), 0));

const dayKey = (date) => localDateString(date.getTime(), env.BUSINESS_TZ);
const rangeBounds = (from, to) => ({
  gte: new Date(zonedToUtcMs(from, 0, 0, env.BUSINESS_TZ)),
  lt: new Date(zonedToUtcMs(addDays(to, 1), 0, 0, env.BUSINESS_TZ)),
});

function eachDay(from, to) {
  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

// ------------------------------------------------------------------ dashboard
export async function buildDashboard() {
  const tz = env.BUSINESS_TZ;
  const today = localDateString(Date.now(), tz);
  const monthStart = `${today.slice(0, 7)}-01`;
  const firstDay = addDays(today, -13);

  const [
    services,
    customers,
    bookings,
    byStatusRows,
    pendingDiscountRequests,
    pendingPayments,
    soldRows,
    pipelineRows,
    recent,
  ] = await Promise.all([
    prisma.service.count({ where: { isActive: true } }),
    prisma.user.count({ where: { role: 'user' } }),
    prisma.appointment.count(),
    prisma.appointment.groupBy({ by: ['status'], _count: { _all: true } }),
    prisma.discountRequest.count({ where: { status: 'pending' } }),
    prisma.appointment.count({ where: { paymentStatus: 'submitted', status: { not: 'cancelled' } } }),
    prisma.appointment.findMany({
      where: { status: { in: SOLD } },
      select: { startTime: true, price: true, serviceId: true, service: { select: { name: true } } },
    }),
    prisma.appointment.findMany({ where: { status: 'pending' }, select: { price: true } }),
    prisma.appointment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 6,
      include: {
        service: true,
        paymentMethod: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
      },
    }),
  ]);

  const withDay = soldRows.map((r) => ({ ...r, day: dayKey(r.startTime), amount: num(r.price) }));
  const period = (pred) => {
    const rows = withDay.filter(pred);
    return { bookings: rows.length, revenue: sum(rows, (r) => r.amount) };
  };

  const byStatus = { pending: 0, confirmed: 0, cancelled: 0, completed: 0 };
  for (const row of byStatusRows) byStatus[row.status] = row._count._all;

  const perService = new Map();
  for (const r of withDay) {
    const entry = perService.get(r.serviceId) ?? { serviceId: r.serviceId, name: r.service.name, bookings: 0, revenue: 0 };
    entry.bookings += 1;
    entry.revenue = round2(entry.revenue + r.amount);
    perService.set(r.serviceId, entry);
  }

  const daily = eachDay(firstDay, today).map((day) => {
    const rows = withDay.filter((r) => r.day === day);
    return { date: day, bookings: rows.length, revenue: sum(rows, (r) => r.amount) };
  });

  return {
    timeZone: tz,
    totals: {
      services,
      customers,
      bookings,
      pendingBookings: byStatus.pending,
      pendingDiscountRequests,
      pendingPayments,
    },
    sales: {
      today: period((r) => r.day === today),
      thisMonth: period((r) => r.day >= monthStart),
      allTime: period(() => true),
      pipeline: { bookings: pipelineRows.length, value: sum(pipelineRows, (r) => num(r.price)) },
    },
    byStatus,
    topServices: [...perService.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    daily,
    recentBookings: recent.map(toAdminAppointment),
  };
}

// -------------------------------------------------------------------- reports
const GROUPS = {
  day: { label: 'Date', key: (r) => dayKey(r.startTime) },
  service: { label: 'Service', key: (r) => r.service.name },
  category: { label: 'Category', key: (r) => r.service.category },
  payment: { label: 'Payment method', key: (r) => r.paymentMethod?.name ?? 'Not selected' },
};

export async function buildSalesReport({ from, to, groupBy }) {
  const rows = await prisma.appointment.findMany({
    where: { startTime: rangeBounds(from, to) },
    select: {
      status: true,
      price: true,
      discountAmount: true,
      paymentStatus: true,
      startTime: true,
      service: { select: { name: true, category: true } },
      paymentMethod: { select: { name: true } },
    },
  });

  const sold = rows.filter((r) => SOLD.includes(r.status));
  const revenue = sum(sold, (r) => num(r.price));
  const paid = sum(sold.filter((r) => r.paymentStatus === 'paid'), (r) => num(r.price));

  const group = GROUPS[groupBy];
  const buckets = new Map();
  if (groupBy === 'day') for (const d of eachDay(from, to)) buckets.set(d, { key: d, bookings: 0, revenue: 0, discounts: 0 });
  for (const r of sold) {
    const key = group.key(r);
    const b = buckets.get(key) ?? { key, bookings: 0, revenue: 0, discounts: 0 };
    b.bookings += 1;
    b.revenue = round2(b.revenue + num(r.price));
    b.discounts = round2(b.discounts + num(r.discountAmount));
    buckets.set(key, b);
  }
  const list = [...buckets.values()];
  if (groupBy !== 'day') list.sort((a, b) => b.revenue - a.revenue);

  return {
    from,
    to,
    groupBy,
    groupLabel: group.label,
    timeZone: env.BUSINESS_TZ,
    summary: {
      revenue,
      bookings: sold.length,
      averageOrderValue: sold.length ? round2(revenue / sold.length) : 0,
      discountsGiven: sum(sold, (r) => num(r.discountAmount)),
      paidAmount: paid,
      unpaidAmount: round2(revenue - paid),
      cancelledBookings: rows.filter((r) => r.status === 'cancelled').length,
      pendingBookings: rows.filter((r) => r.status === 'pending').length,
    },
    rows: list,
  };
}

const csvCell = (v) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function reportToCsv(report) {
  const header = [report.groupLabel, 'Bookings', 'Revenue (BDT)', 'Discounts (BDT)'];
  const lines = report.rows.map((r) => [r.key, r.bookings, r.revenue, r.discounts]);
  lines.push(['Total', report.summary.bookings, report.summary.revenue, report.summary.discountsGiven]);
  return [header, ...lines].map((cols) => cols.map(csvCell).join(',')).join('\n');
}

const MAX_RANGE_DAYS = 366;

const reportQuery = z
  .object({
    from: z.iso.date('Use YYYY-MM-DD').optional(),
    to: z.iso.date('Use YYYY-MM-DD').optional(),
    groupBy: z.enum(['day', 'service', 'category', 'payment']).default('day'),
  })
  .transform((q) => {
    const to = q.to ?? localDateString(Date.now(), env.BUSINESS_TZ);
    return { ...q, to, from: q.from ?? addDays(to, -29) };
  })
  .refine((q) => q.from <= q.to, { message: '"from" must be on or before "to"', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 < MAX_RANGE_DAYS, {
    message: `The range can be at most ${MAX_RANGE_DAYS} days`,
    path: ['to'],
  });

const router = Router();

router.get('/dashboard', async (_req, res) => {
  ok(res, await buildDashboard());
});

router.get('/reports/sales', validate({ query: reportQuery }), async (req, res) => {
  ok(res, await buildSalesReport(req.valid.query));
});

router.get('/reports/sales.csv', validate({ query: reportQuery }), async (req, res) => {
  const report = await buildSalesReport(req.valid.query);
  res
    .set('Content-Type', 'text/csv; charset=utf-8')
    .set('Content-Disposition', `attachment; filename="seba-sales-${report.from}_${report.to}.csv"`)
    .send(reportToCsv(report));
});

export default router;

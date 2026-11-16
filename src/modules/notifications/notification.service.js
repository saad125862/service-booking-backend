import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';

export const toNotification = (n) => ({
  id: n.id,
  type: n.type,
  title: n.title,
  body: n.body,
  data: n.data ?? null,
  isRead: n.readAt !== null,
  createdAt: n.createdAt,
});

const clip = (s, max) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * Creates a notification. Best effort: a failure here must never break the booking
 * action that triggered it, so errors are logged and swallowed.
 */
export async function notify(userId, { type, title, body, data }) {
  try {
    await prisma.notification.create({
      data: { userId, type, title: clip(title, 120), body: clip(body, 500), data: data ?? undefined },
    });
  } catch (err) {
    console.error('Could not create notification:', err.message);
  }
}

export async function notifyAdmins({ type, title, body, data }) {
  try {
    const admins = await prisma.user.findMany({ where: { role: 'admin' }, select: { id: true } });
    if (admins.length === 0) return;
    await prisma.notification.createMany({
      data: admins.map((a) => ({
        userId: a.id,
        type,
        title: clip(title, 120),
        body: clip(body, 500),
        data: data ?? undefined,
      })),
    });
  } catch (err) {
    console.error('Could not notify admins:', err.message);
  }
}

export async function listNotifications(userId, { unreadOnly, page, limit }) {
  const where = { userId, ...(unreadOnly && { readAt: null }) };
  const [total, unread, rows] = await Promise.all([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId, readAt: null } }),
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
  ]);
  return {
    items: rows.map(toNotification),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit), unreadCount: unread },
  };
}

export const unreadCount = (userId) => prisma.notification.count({ where: { userId, readAt: null } });

export async function markRead(userId, id) {
  // Scoped to the owner; marking an already-read one keeps its original read time.
  const { count } = await prisma.notification.updateMany({
    where: { id, userId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, userId }, select: { id: true } });
    if (!exists) throw ApiError.notFound('Notification not found');
  }
  return prisma.notification.findFirst({ where: { id, userId } }).then(toNotification);
}

export async function markAllRead(userId) {
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null },
    data: { readAt: new Date() },
  });
  return count;
}

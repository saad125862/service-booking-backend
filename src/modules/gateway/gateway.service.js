import { randomBytes } from 'node:crypto';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { notify, notifyAdmins } from '../notifications/notification.service.js';
import { PROVIDERS, availableProviders, callbackUrls } from './providers.js';

// Online payments: a customer pays a booking through a gateway-hosted checkout for the booking's
// exact price. We create a session (our own unguessable transaction id), the gateway sends the
// customer back, and we confirm with the gateway before marking the booking paid.

const PAYABLE = ['unpaid', 'failed'];
const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;

/** Can this booking be paid online right now? */
export const canPayOnline = (a) =>
  a.status !== 'cancelled' && PAYABLE.includes(a.paymentStatus) && Number(a.price) > 0 && availableProviders().length > 0;

export async function startOnlinePayment(userId, appointmentId, { provider } = {}) {
  const appointment = await prisma.appointment.findFirst({
    where: { id: appointmentId, userId },
    include: { service: true, paymentMethod: true, user: { select: { name: true, email: true, phone: true } } },
  });
  if (!appointment) throw ApiError.notFound('Booking not found');
  if (appointment.status === 'cancelled') throw ApiError.conflict('NOT_PAYABLE', 'This booking was cancelled');
  if (appointment.paymentStatus === 'paid') throw ApiError.conflict('ALREADY_PAID', 'This booking is already paid');
  if (!PAYABLE.includes(appointment.paymentStatus)) {
    throw ApiError.conflict('NOT_PAYABLE', 'A payment for this booking is already waiting for verification');
  }
  if (Number(appointment.price) <= 0) throw ApiError.conflict('NOT_PAYABLE', 'There is nothing to pay for this booking');

  const available = availableProviders();
  const chosen = provider ?? appointment.paymentMethod?.gatewayProvider ?? available[0]?.code;
  const adapter = PROVIDERS[chosen];
  if (!adapter || !adapter.isConfigured()) {
    throw new ApiError(400, 'PROVIDER_UNAVAILABLE', 'Online payment is not available right now. Choose another payment option.');
  }

  const session = await prisma.paymentSession.create({
    data: {
      appointmentId: appointment.id,
      provider: adapter.code,
      tranId: `SEBA${Date.now().toString(36).toUpperCase()}${randomBytes(10).toString('hex').toUpperCase()}`,
      amount: appointment.price,
    },
  });

  let url;
  try {
    ({ url } = await adapter.createCheckout({
      session,
      appointment,
      customer: appointment.user,
      urls: callbackUrls(adapter.code),
    }));
  } catch (err) {
    await prisma.paymentSession.update({ where: { id: session.id }, data: { status: 'failed', completedAt: new Date() } });
    throw err;
  }

  await prisma.paymentSession.update({ where: { id: session.id }, data: { gatewayUrl: url } });

  // Remember that this booking is being paid through this gateway.
  if (appointment.paymentMethod?.gatewayProvider !== adapter.code) {
    const method = await prisma.paymentMethod.findFirst({ where: { gatewayProvider: adapter.code, isActive: true } });
    if (method) {
      await prisma.appointment.update({ where: { id: appointment.id }, data: { paymentMethodId: method.id } });
    }
  }

  return {
    sessionId: session.id,
    provider: adapter.code,
    providerName: adapter.name,
    amount: Number(session.amount),
    currency: 'BDT',
    url,
  };
}

/**
 * Handles the gateway sending the customer (or an IPN) back. `outcome` is success | fail | cancel | ipn.
 * Returns { state: paid | failed | cancelled | unknown, appointmentId? }.
 */
export async function handleGatewayReturn(providerCode, outcome, payload) {
  const adapter = PROVIDERS[providerCode];
  const tranId = String(payload.tran_id ?? payload.mer_txnid ?? '');
  if (!adapter || !adapter.isConfigured() || !tranId) return { state: 'unknown' };

  const session = await prisma.paymentSession.findUnique({ where: { tranId }, include: { appointment: { include: { service: true } } } });
  if (!session || session.provider !== adapter.code) return { state: 'unknown' };
  const result = { appointmentId: session.appointmentId };

  if (session.status === 'paid') return { ...result, state: 'paid' }; // repeated callback / IPN

  if (outcome === 'cancel' || outcome === 'fail') {
    if (session.status === 'initiated') {
      await prisma.paymentSession.update({
        where: { id: session.id },
        data: { status: outcome === 'cancel' ? 'cancelled' : 'failed', completedAt: new Date() },
      });
    }
    return { ...result, state: outcome === 'cancel' ? 'cancelled' : 'failed' };
  }

  // success / ipn: never trust the browser, ask the gateway.
  const verdict = await adapter.verify({ session, payload });
  const sameAmount = Math.abs((verdict.amount ?? NaN) - Number(session.amount)) < 0.01;
  const sameTran = !verdict.tranId || verdict.tranId === session.tranId;
  if (!verdict.valid || !sameAmount || !sameTran) {
    if (session.status === 'initiated') {
      await prisma.paymentSession.update({ where: { id: session.id }, data: { status: 'failed', completedAt: new Date() } });
    }
    return { ...result, state: 'failed' };
  }

  const now = new Date();
  const reference = (verdict.reference ?? tranId).slice(0, 60);
  const won = await prisma.$transaction(async (tx) => {
    // Only the first confirmation wins (callback and IPN can arrive together).
    const claimed = await tx.paymentSession.updateMany({
      where: { id: session.id, status: { not: 'paid' } },
      data: { status: 'paid', gatewayRef: reference, completedAt: now },
    });
    if (claimed.count === 0) return false;
    await tx.appointment.update({
      where: { id: session.appointmentId },
      data: { paymentStatus: 'paid', paymentReference: reference, paidAt: now },
    });
    return true;
  });

  if (won) {
    const a = session.appointment;
    const data = { appointmentId: a.id };
    await notify(a.userId, {
      type: 'payment_received',
      title: 'Payment received',
      body: `We received ${money(session.amount)} for ${a.service.name}. Thank you!`,
      data,
    });
    await notifyAdmins({
      type: 'payment_received',
      title: 'Online payment received',
      body: `${money(session.amount)} paid online for ${a.service.name} (${adapter.name}).`,
      data,
    });
  }
  return { ...result, state: 'paid' };
}

/** Used by the demo checkout page. */
export const findSession = (tranId) =>
  prisma.paymentSession.findUnique({ where: { tranId }, include: { appointment: { include: { service: true } } } });

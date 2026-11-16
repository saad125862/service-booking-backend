import { prisma } from '../../db/prisma.js';
import { PROVIDERS } from '../gateway/providers.js';

// Payment options are configured by admins. The API records the customer's choice (and the
// transaction reference for wallet payments such as bKash) and an admin verifies it; no money
// moves through this server, so no payment-provider secrets are needed.

export const toPaymentMethod = (m, { admin = false } = {}) => ({
  id: m.id,
  code: m.code,
  name: m.name,
  type: m.type,
  instructions: m.instructions,
  accountNumber: m.accountNumber,
  requiresReference: m.requiresReference,
  // Online methods are paid through a gateway: the customer gets a checkout link after booking.
  online: Boolean(m.gatewayProvider),
  ...(admin && {
    gatewayProvider: m.gatewayProvider,
    providerReady: m.gatewayProvider ? Boolean(PROVIDERS[m.gatewayProvider]?.isConfigured()) : true,
    isActive: m.isActive,
    sortOrder: m.sortOrder,
  }),
});

export async function listPaymentMethods({ includeInactive = false } = {}) {
  const rows = await prisma.paymentMethod.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });
  // Customers never see an online option whose gateway is not configured on this server.
  return includeInactive ? rows : rows.filter((m) => !m.gatewayProvider || PROVIDERS[m.gatewayProvider]?.isConfigured());
}

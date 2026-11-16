import { prisma } from '../../db/prisma.js';

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
  ...(admin && { isActive: m.isActive, sortOrder: m.sortOrder }),
});

export const listPaymentMethods = ({ includeInactive = false } = {}) =>
  prisma.paymentMethod.findMany({
    where: includeInactive ? {} : { isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
  });

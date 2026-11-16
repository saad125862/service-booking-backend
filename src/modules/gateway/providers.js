import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

// Payment gateway adapters. Each one can (1) create a hosted checkout for an exact amount and
// (2) ask the gateway, server to server, whether a payment really happened. The callback the
// customer's browser makes is never trusted on its own: only `verify` decides if money arrived.
//
//   createCheckout({ session, appointment, customer, urls }) -> { url }
//   verify({ session, payload })                              -> { valid, amount, reference }

const callbackUrl = (provider, outcome) => `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/payments/gateway/${provider}/${outcome}`;

export const callbackUrls = (provider) => ({
  success: callbackUrl(provider, 'success'),
  fail: callbackUrl(provider, 'fail'),
  cancel: callbackUrl(provider, 'cancel'),
  ipn: callbackUrl(provider, 'ipn'),
});

async function httpJson(url, init) {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment gateway could not be reached. Please try again.');
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', 'The payment gateway sent an unexpected answer.');
  }
}

const customerPhone = (c) => c.phone || '01700000000';

// ------------------------------------------------------------------ SSLCommerz
const sslBase = () => (env.SSLCOMMERZ_SANDBOX ? 'https://sandbox.sslcommerz.com' : 'https://securepay.sslcommerz.com');

const sslcommerz = {
  code: 'sslcommerz',
  name: 'SSLCommerz',
  isConfigured: () => Boolean(env.SSLCOMMERZ_STORE_ID && env.SSLCOMMERZ_STORE_PASSWORD),

  async createCheckout({ session, appointment, customer, urls }) {
    const body = new URLSearchParams({
      store_id: env.SSLCOMMERZ_STORE_ID,
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD,
      total_amount: Number(session.amount).toFixed(2),
      currency: 'BDT',
      tran_id: session.tranId,
      success_url: urls.success,
      fail_url: urls.fail,
      cancel_url: urls.cancel,
      ipn_url: urls.ipn,
      cus_name: customer.name,
      cus_email: customer.email,
      cus_add1: appointment.address ?? 'Dhaka',
      cus_city: 'Dhaka',
      cus_country: 'Bangladesh',
      cus_phone: customerPhone(customer),
      shipping_method: 'NO',
      product_name: appointment.service.name,
      product_category: appointment.service.category,
      product_profile: 'general',
    });
    const data = await httpJson(`${sslBase()}/gwprocess/v4/api.php`, { method: 'POST', body });
    if (data.status !== 'SUCCESS' || !data.GatewayPageURL) {
      throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', data.failedreason || 'SSLCommerz could not start the payment.');
    }
    return { url: data.GatewayPageURL };
  },

  async verify({ payload }) {
    if (!payload.val_id) return { valid: false };
    const qs = new URLSearchParams({
      val_id: payload.val_id,
      store_id: env.SSLCOMMERZ_STORE_ID,
      store_passwd: env.SSLCOMMERZ_STORE_PASSWORD,
      format: 'json',
    });
    const data = await httpJson(`${sslBase()}/validator/api/validationserverAPI.php?${qs}`);
    const valid = ['VALID', 'VALIDATED'].includes(data.status);
    return { valid, tranId: data.tran_id, amount: Number(data.amount), reference: data.bank_tran_id || data.val_id };
  },
};

// -------------------------------------------------------------------- aamarPay
const aamarBase = () => (env.AAMARPAY_SANDBOX ? 'https://sandbox.aamarpay.com' : 'https://secure.aamarpay.com');

const aamarpay = {
  code: 'aamarpay',
  name: 'aamarPay',
  isConfigured: () => Boolean(env.AAMARPAY_STORE_ID && env.AAMARPAY_SIGNATURE_KEY),

  async createCheckout({ session, appointment, customer, urls }) {
    const data = await httpJson(`${aamarBase()}/jsonpost.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        store_id: env.AAMARPAY_STORE_ID,
        signature_key: env.AAMARPAY_SIGNATURE_KEY,
        tran_id: session.tranId,
        amount: Number(session.amount).toFixed(2),
        currency: 'BDT',
        desc: `${appointment.service.name} booking`,
        cus_name: customer.name,
        cus_email: customer.email,
        cus_phone: customerPhone(customer),
        cus_add1: appointment.address ?? 'Dhaka',
        cus_city: 'Dhaka',
        cus_country: 'Bangladesh',
        success_url: urls.success,
        fail_url: urls.fail,
        cancel_url: urls.cancel,
        type: 'json',
      }),
    });
    if (!data.payment_url) {
      const why = typeof data === 'string' ? data : data.error || data.message;
      throw new ApiError(502, 'PAYMENT_GATEWAY_ERROR', `aamarPay could not start the payment${why ? `: ${why}` : '.'}`);
    }
    return { url: data.payment_url };
  },

  async verify({ session }) {
    const qs = new URLSearchParams({
      request_id: session.tranId,
      store_id: env.AAMARPAY_STORE_ID,
      signature_key: env.AAMARPAY_SIGNATURE_KEY,
      type: 'json',
    });
    const data = await httpJson(`${aamarBase()}/api/v1/trxcheck/request.php?${qs}`);
    const valid = String(data.pay_status).toLowerCase() === 'successful';
    return {
      valid,
      tranId: data.mer_txnid,
      amount: Number(data.amount_original ?? data.amount),
      reference: data.bank_trxid || data.pg_txnid,
    };
  },
};

// ------------------------------------------------------------------------ mock
// A fake hosted checkout (see gateway.routes.js) so the whole flow can be demoed and tested
// without gateway accounts. Only offered when GATEWAY_MOCK_ENABLED is on.
const mock = {
  code: 'mock',
  name: 'Demo checkout',
  isConfigured: () => env.GATEWAY_MOCK_ENABLED,

  async createCheckout({ session }) {
    return { url: `${env.PUBLIC_API_URL.replace(/\/$/, '')}/api/v1/payments/gateway/mock/checkout/${session.tranId}` };
  },

  async verify({ session, payload }) {
    const valid = payload.status === 'paid';
    return { valid, tranId: session.tranId, amount: Number(session.amount), reference: `DEMO-${session.tranId.slice(-8).toUpperCase()}` };
  },
};

export const PROVIDERS = { sslcommerz, aamarpay, mock };
export const availableProviders = () => Object.values(PROVIDERS).filter((p) => p.isConfigured());

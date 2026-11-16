import { Router } from 'express';
import express from 'express';
import { PROVIDERS } from './providers.js';
import { findSession, handleGatewayReturn } from './gateway.service.js';

// Public endpoints the payment gateways redirect the customer's browser to (and, for SSLCommerz,
// call as an IPN). They carry no JWT: a payment is only accepted after the gateway itself confirms
// it (see gateway.service). The pages are plain HTML because they open in the phone's browser.

const router = Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;

function page({ title, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#fff8f3;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#2b2118}
  .card{max-width:420px;margin:24px;padding:32px 28px;background:#fff;border-radius:20px;box-shadow:0 8px 30px rgba(120,60,10,.12);text-align:center}
  h1{font-size:22px;margin:12px 0 8px} p{margin:6px 0;color:#6b5646;line-height:1.5}
  .icon{font-size:44px} .brand{color:#e8590c;font-weight:800;letter-spacing:.3px}
  button{margin-top:14px;width:100%;padding:14px;border:0;border-radius:12px;font-size:16px;font-weight:700;cursor:pointer}
  .pay{background:#e8590c;color:#fff} .fail{background:#f1e7df;color:#2b2118}
</style></head><body><div class="card"><div class="brand">Seba · সেবা</div>${body}</div></body></html>`;
}

const RESULTS = {
  paid: { icon: '✅', title: 'Payment received', text: 'Thank you! Your booking is paid. You can close this tab and go back to the Seba app.' },
  failed: { icon: '⚠️', title: 'Payment not completed', text: 'The payment did not go through and you have not been charged. Go back to the Seba app to try again.' },
  cancelled: { icon: '↩️', title: 'Payment cancelled', text: 'You cancelled the payment. Go back to the Seba app whenever you are ready to pay.' },
  unknown: { icon: '❓', title: 'We could not find that payment', text: 'Please go back to the Seba app and check your booking.' },
};

const resultPage = (state) => {
  const r = RESULTS[state] ?? RESULTS.unknown;
  return page({ title: r.title, body: `<div class="icon">${r.icon}</div><h1>${esc(r.title)}</h1><p>${esc(r.text)}</p>` });
};

// ---------------------------------------------------------------- demo checkout
router.get('/mock/checkout/:tranId', async (req, res) => {
  const session = PROVIDERS.mock.isConfigured() ? await findSession(String(req.params.tranId)) : null;
  if (!session || session.provider !== 'mock' || session.status !== 'initiated') {
    return res.status(404).type('html').send(resultPage('unknown'));
  }
  const field = `<input type="hidden" name="tran_id" value="${esc(session.tranId)}">`;
  const base = '/api/v1/payments/gateway/mock';
  res.type('html').send(
    page({
      title: 'Demo checkout',
      body: `<div class="icon">💳</div><h1>Demo checkout</h1>
<p>${esc(session.appointment.service.name)}</p><p style="font-size:28px;font-weight:800;color:#2b2118">${money(session.amount)}</p>
<p>This is a pretend gateway for demos. No real money moves.</p>
<form method="post" action="${base}/success">${field}<input type="hidden" name="status" value="paid"><button class="pay">Pay ${money(session.amount)}</button></form>
<form method="post" action="${base}/fail">${field}<button class="fail">Make it fail</button></form>
<form method="post" action="${base}/cancel">${field}<button class="fail">Cancel</button></form>`,
    }),
  );
});

// -------------------------------------------------------------- gateway returns
// GET and POST: SSLCommerz and aamarPay post the customer back, some setups use GET.
router.all('/:provider/:outcome', async (req, res) => {
  const { provider, outcome } = req.params;
  if (!['success', 'fail', 'cancel', 'ipn'].includes(outcome)) return res.status(404).type('html').send(resultPage('unknown'));

  const payload = { ...req.query, ...(req.body ?? {}) };
  const { state } = await handleGatewayReturn(provider, outcome, payload);

  // IPNs are machine to machine: answer with a short status, not a page.
  if (outcome === 'ipn') return res.status(200).json({ received: true, state });
  res.status(state === 'unknown' ? 404 : 200).type('html').send(resultPage(state));
});

export default router;

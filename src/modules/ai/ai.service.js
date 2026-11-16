import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { buildSystemInstruction } from './ai.prompt.js';
import { generate } from './gemini.js';
import { createDiscountRequest } from '../discounts/discount.service.js';
import { canPayOnline, startOnlinePayment } from '../gateway/gateway.service.js';
import { formatDateTime } from '../../utils/time.js';
import { env } from '../../config/env.js';

const CATALOG_TTL_MS = 60_000;

// Structured output: the app gets the reply, the detected language, the service ids to render
// as cards, and whether the customer is asking for a discount (which needs an admin).
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['en', 'bn', 'banglish'] },
    reply: { type: 'string' },
    recommendedServiceIds: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    intent: { type: 'string', enum: ['none', 'discount_clarify', 'discount_request', 'pay_booking'] },
    discountServiceId: { type: 'string' },
  },
  required: ['language', 'reply', 'recommendedServiceIds', 'intent', 'discountServiceId'],
};

const modelOutput = z.object({
  language: z.enum(['en', 'bn', 'banglish']).catch('en'),
  reply: z.string().trim().min(1),
  recommendedServiceIds: z.array(z.string()).default([]),
  intent: z.enum(['none', 'discount_clarify', 'discount_request', 'pay_booking']).catch('none'),
  discountServiceId: z.string().default(''),
});

let catalogCache = { at: 0, services: [] };
async function loadCatalog() {
  if (Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.services;
  const services = await prisma.service.findMany({ where: { isActive: true }, orderBy: { name: 'asc' } });
  catalogCache = { at: Date.now(), services };
  return services;
}

const catalogLine = (s) =>
  [s.id, s.name, s.category, Number(s.price), s.durationMinutes, s.isFeatured ? 'featured' : '-', s.description].join(' | ');

// Gemini wants alternating turns starting with the user, so drop any leading assistant messages.
function toContents(history, message) {
  const turns = history.map((h) => ({ role: h.role === 'assistant' ? 'model' : 'user', parts: [{ text: h.content }] }));
  while (turns.length && turns[0].role === 'model') turns.shift();
  return [...turns, { role: 'user', parts: [{ text: message }] }];
}

// Asked when a discount is wanted but the exact service is not known yet (also the safety net if
// the model forgets to).
const WHICH_SERVICE = {
  en: 'Happy to ask for that. Which service exactly would you like a discount on? Please tell me the service name.',
  bn: 'অবশ্যই। কোন সার্ভিসে ছাড় চান? অনুগ্রহ করে সার্ভিসের নামটি বলুন।',
  banglish: 'Obossoi. Kon service e discount chan? Service er naam ta bolun.',
};

const money = (n) => `৳${Number(n).toLocaleString('en-US')}`;

// Replies for the payment flow are written here, not by the model, so the amount and service
// are always exactly the booking's.
const PAY_TEXT = {
  link: {
    en: (name, when, amount) => `Here is your secure payment link for ${name} on ${when}: ${money(amount)}. Tap the button below to pay.`,
    bn: (name, when, amount) => `${name} (${when}) বুকিংয়ের জন্য আপনার নিরাপদ পেমেন্ট লিংক এখানে: ${money(amount)}। পেমেন্ট করতে নিচের বাটনে ট্যাপ করুন।`,
    banglish: (name, when, amount) => `${name} (${when}) booking er secure payment link ready: ${money(amount)}. Pay korte niche button e tap korun.`,
  },
  none: {
    en: 'You have no booking waiting for an online payment right now. Book a service first, then I can send you a payment link.',
    bn: 'এই মুহূর্তে অনলাইনে পেমেন্টের জন্য আপনার কোনো বুকিং অপেক্ষায় নেই। আগে একটি সার্ভিস বুক করুন, তারপর আমি পেমেন্ট লিংক দিতে পারব।',
    banglish: 'Ekhon online payment er jonno apnar kono booking nei. Age ekta service book korun, tarpor ami payment link dibo.',
  },
  unavailable: {
    en: 'Online payment is not available right now. You can pay in cash or by card when the service is done, or with bKash or Nagad.',
    bn: 'এখন অনলাইন পেমেন্ট চালু নেই। সার্ভিস শেষে নগদ বা কার্ডে, অথবা বিকাশ/নগদে পেমেন্ট করতে পারবেন।',
    banglish: 'Ekhon online payment chalu nei. Service sesh e cash ba card e, othoba bKash/Nagad e payment korte paren.',
  },
};

/** The customer's nearest upcoming booking that can still be paid online, with a fresh checkout link. */
async function buildPaymentLink(userId, language) {
  const candidates = await prisma.appointment.findMany({
    where: { userId, status: { in: ['pending', 'confirmed'] }, paymentStatus: { in: ['unpaid', 'failed'] } },
    include: { service: true },
    orderBy: { startTime: 'asc' },
    take: 5,
  });
  const booking = candidates.find((a) => canPayOnline(a));
  if (!booking) {
    const anyPayable = candidates.length > 0;
    return { reply: PAY_TEXT[anyPayable ? 'unavailable' : 'none'][language] ?? PAY_TEXT.none.en, paymentLink: null };
  }
  const session = await startOnlinePayment(userId, booking.id);
  const when = formatDateTime(booking.startTime.getTime(), env.BUSINESS_TZ);
  const text = PAY_TEXT.link[language] ?? PAY_TEXT.link.en;
  return {
    reply: text(booking.service.name, when, session.amount),
    paymentLink: {
      appointmentId: booking.id,
      serviceName: booking.service.name,
      startLabel: when,
      amount: session.amount,
      provider: session.provider,
      providerName: session.providerName,
      url: session.url,
    },
  };
}

const toRecommended = (s) => ({
  id: s.id,
  name: s.name,
  category: s.category,
  price: Number(s.price),
  durationMinutes: s.durationMinutes,
  imageUrl: s.imageUrl,
});

export async function chat({ userId, message, history }) {
  const services = await loadCatalog();
  const systemInstruction = buildSystemInstruction(services.map(catalogLine).join('\n'));

  // Throws 503 AI_NOT_CONFIGURED / AI_UNAVAILABLE when Gemini cannot be used.
  const text = await generate({
    systemInstruction,
    contents: toContents(history, message),
    responseJsonSchema: RESPONSE_SCHEMA,
  });

  let parsed;
  try {
    parsed = modelOutput.parse(JSON.parse(text));
  } catch {
    // Model ignored the schema: still return something useful instead of failing the chat.
    parsed = {
      language: 'en',
      reply: text.trim() || 'Sorry, I could not answer that. Please try again.',
      recommendedServiceIds: [],
      intent: 'none',
      discountServiceId: '',
    };
  }

  // Only ever return services that really exist in the catalog (guards against invented ids).
  const byId = new Map(services.map((s) => [s.id, s]));
  let recommendedServices = [...new Set(parsed.recommendedServiceIds)]
    .filter((id) => byId.has(id))
    .slice(0, 3)
    .map((id) => toRecommended(byId.get(id)));
  let reply = parsed.reply;

  // The assistant never grants a discount itself: it hands the request to the admins and
  // tells the customer it is being reviewed. The decision arrives later (see discount.service).
  // A discount request is only ever filed for ONE exact service. If the model says it is a request
  // but did not give a valid service, ask which service instead of guessing.
  let discountRequest = null;
  if (parsed.intent === 'discount_request') {
    const serviceId = byId.has(parsed.discountServiceId) ? parsed.discountServiceId : null;
    if (!serviceId) {
      reply = WHICH_SERVICE[parsed.language] ?? WHICH_SERVICE.en;
      if (recommendedServices.length === 0) {
        recommendedServices = services.filter((s) => s.isFeatured).slice(0, 3).map(toRecommended);
      }
    } else {
      const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
      if (me?.role === 'user') {
        const { request, created } = await createDiscountRequest(userId, {
          serviceId,
          message,
          language: parsed.language,
        });
        discountRequest = { id: request.id, status: request.status, created };
      }
    }
  }

  // Paying: the app (not the model) finds the booking and creates the gateway link for its exact price.
  let paymentLink = null;
  if (parsed.intent === 'pay_booking') {
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (me?.role === 'user') {
      ({ reply, paymentLink } = await buildPaymentLink(userId, parsed.language));
      recommendedServices = [];
    }
  }

  return { reply, language: parsed.language, recommendedServices, discountRequest, paymentLink };
}

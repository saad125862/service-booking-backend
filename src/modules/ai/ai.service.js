import { z } from 'zod';
import { prisma } from '../../db/prisma.js';
import { buildSystemInstruction } from './ai.prompt.js';
import { generate } from './gemini.js';
import { createDiscountRequest } from '../discounts/discount.service.js';

const CATALOG_TTL_MS = 60_000;

// Structured output: the app gets the reply, the detected language, the service ids to render
// as cards, and whether the customer is asking for a discount (which needs an admin).
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['en', 'bn', 'banglish'] },
    reply: { type: 'string' },
    recommendedServiceIds: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    intent: { type: 'string', enum: ['none', 'discount_request'] },
    discountServiceId: { type: 'string' },
  },
  required: ['language', 'reply', 'recommendedServiceIds', 'intent', 'discountServiceId'],
};

const modelOutput = z.object({
  language: z.enum(['en', 'bn', 'banglish']).catch('en'),
  reply: z.string().trim().min(1),
  recommendedServiceIds: z.array(z.string()).default([]),
  intent: z.enum(['none', 'discount_request']).catch('none'),
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
  const recommendedServices = [...new Set(parsed.recommendedServiceIds)]
    .filter((id) => byId.has(id))
    .slice(0, 3)
    .map((id) => {
      const s = byId.get(id);
      return {
        id: s.id,
        name: s.name,
        category: s.category,
        price: Number(s.price),
        durationMinutes: s.durationMinutes,
        imageUrl: s.imageUrl,
      };
    });

  // The assistant never grants a discount itself: it hands the request to the admins and
  // tells the customer it is being reviewed. The decision arrives later (see discount.service).
  let discountRequest = null;
  if (parsed.intent === 'discount_request') {
    const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (me?.role === 'user') {
      const serviceId = byId.has(parsed.discountServiceId) ? parsed.discountServiceId : null;
      const { request, created } = await createDiscountRequest(userId, {
        serviceId,
        message,
        language: parsed.language,
      });
      discountRequest = { id: request.id, status: request.status, created };
    }
  }

  return { reply: parsed.reply, language: parsed.language, recommendedServices, discountRequest };
}

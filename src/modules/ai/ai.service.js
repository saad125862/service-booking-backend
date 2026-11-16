import { GoogleGenAI } from '@google/genai';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { prisma } from '../../db/prisma.js';
import { ApiError } from '../../utils/ApiError.js';
import { buildSystemInstruction } from './ai.prompt.js';

const TIMEOUT_MS = 20_000;
const CATALOG_TTL_MS = 60_000;

// Structured output: the app gets the reply, the detected language, and service ids to render as cards.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    language: { type: 'string', enum: ['en', 'bn', 'banglish'] },
    reply: { type: 'string' },
    recommendedServiceIds: { type: 'array', items: { type: 'string' }, maxItems: 3 },
  },
  required: ['language', 'reply', 'recommendedServiceIds'],
};

const modelOutput = z.object({
  language: z.enum(['en', 'bn', 'banglish']).catch('en'),
  reply: z.string().trim().min(1),
  recommendedServiceIds: z.array(z.string()).default([]),
});

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));

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

async function generate(model, systemInstruction, contents) {
  const response = await getClient().models.generateContent({
    model,
    contents,
    config: {
      systemInstruction,
      responseMimeType: 'application/json',
      responseJsonSchema: RESPONSE_SCHEMA,
      temperature: 0.5,
      maxOutputTokens: 1024,
      httpOptions: { timeout: TIMEOUT_MS },
    },
  });
  return response.text ?? '';
}

// Errors worth retrying on the fallback model: overload, rate limit, model gone, timeouts.
const retryable = (err) =>
  [404, 429, 500, 502, 503, 504].includes(err?.status) || /timeout|abort|fetch failed/i.test(err?.message ?? '');

export async function chat({ message, history }) {
  if (!env.GEMINI_API_KEY) {
    throw new ApiError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured on this server');
  }

  const services = await loadCatalog();
  const systemInstruction = buildSystemInstruction(services.map(catalogLine).join('\n'));
  const contents = toContents(history, message);

  const models = [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter((m, i, all) => m && all.indexOf(m) === i);
  let text;
  for (const [i, model] of models.entries()) {
    try {
      text = await generate(model, systemInstruction, contents);
      break;
    } catch (err) {
      console.error(`Gemini call failed (model=${model}, status=${err?.status ?? '-'}):`, err?.message?.slice(0, 200));
      if (i === models.length - 1 || !retryable(err)) {
        throw new ApiError(503, 'AI_UNAVAILABLE', 'The assistant is busy right now. Please try again in a moment.');
      }
    }
  }

  let parsed;
  try {
    parsed = modelOutput.parse(JSON.parse(text));
  } catch {
    // Model ignored the schema: still return something useful instead of failing the chat.
    parsed = { language: 'en', reply: text.trim() || 'Sorry, I could not answer that. Please try again.', recommendedServiceIds: [] };
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

  return { reply: parsed.reply, language: parsed.language, recommendedServices };
}

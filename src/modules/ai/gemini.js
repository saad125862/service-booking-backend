import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';

// Thin wrapper around the Gemini API shared by the chat assistant and the discount replies.
// The API key is read from the server environment only.

const TIMEOUT_MS = 20_000;

let client;
const getClient = () => (client ??= new GoogleGenAI({ apiKey: env.GEMINI_API_KEY }));

export const isGeminiConfigured = () => Boolean(env.GEMINI_API_KEY);

// Errors worth retrying on the fallback model: overload, rate limit, model gone, timeouts.
const retryable = (err) =>
  [404, 429, 500, 502, 503, 504].includes(err?.status) || /timeout|abort|fetch failed/i.test(err?.message ?? '');

/**
 * Calls the primary model and, on a retryable failure, the fallback model once.
 * Resolves to the response text; throws ApiError 503 AI_UNAVAILABLE if both fail.
 */
export async function generate({ systemInstruction, contents, responseJsonSchema, temperature = 0.5 }) {
  if (!isGeminiConfigured()) {
    throw new ApiError(503, 'AI_NOT_CONFIGURED', 'The AI assistant is not configured on this server');
  }

  const models = [env.GEMINI_MODEL, env.GEMINI_FALLBACK_MODEL].filter((m, i, all) => m && all.indexOf(m) === i);
  for (const [i, model] of models.entries()) {
    try {
      const response = await getClient().models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          ...(responseJsonSchema && { responseMimeType: 'application/json', responseJsonSchema }),
          temperature,
          maxOutputTokens: 1024,
          httpOptions: { timeout: TIMEOUT_MS },
        },
      });
      return response.text ?? '';
    } catch (err) {
      console.error(`Gemini call failed (model=${model}, status=${err?.status ?? '-'}):`, err?.message?.slice(0, 200));
      if (i === models.length - 1 || !retryable(err)) {
        throw new ApiError(503, 'AI_UNAVAILABLE', 'The assistant is busy right now. Please try again in a moment.');
      }
    }
  }
  return '';
}

/** Plain text generation (no structured output). */
export const generateText = (systemInstruction, userText) =>
  generate({ systemInstruction, contents: [{ role: 'user', parts: [{ text: userText }] }], temperature: 0.6 });

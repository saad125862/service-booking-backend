import { generateText, isGeminiConfigured } from '../ai/gemini.js';

// The assistant's answer to a customer once an admin has decided on their discount request.
// It is written by Gemini in the customer's language; if the AI is unavailable we fall back
// to fixed templates (English, Bangla, Banglish) so the customer always gets an answer.

const LANGUAGE_NAMES = {
  en: 'English',
  bn: 'Bangla written in Bengali script',
  banglish: 'Banglish (Bangla written in Latin letters, casual texting style)',
};

const formatBdt = (n) => `৳${Number(n).toLocaleString('en-US')}`;

const describeDiscount = (type, value) => (type === 'percent' ? `${Number(value)}%` : formatBdt(value));

const formatDate = (date, tz) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(date);

function template({ language, decision, serviceName, type, value, validUntil, note }) {
  const what = serviceName ?? '';
  const amount = type ? describeDiscount(type, value) : '';
  const lang = LANGUAGE_NAMES[language] ? language : 'en';

  if (decision === 'approved') {
    return {
      en: `Good news! An admin approved ${amount} off${what ? ` ${what}` : ' your next booking'}. It is valid until ${validUntil} and will be applied automatically when you book.${note ? ` Note from the admin: ${note}` : ''}`,
      bn: `সুখবর! একজন অ্যাডমিন ${what ? `${what}-এ ` : 'আপনার পরবর্তী বুকিংয়ে '}${amount} ছাড় অনুমোদন করেছেন। এটি ${validUntil} পর্যন্ত বৈধ এবং বুকিং করার সময় নিজে থেকেই প্রযোজ্য হবে।${note ? ` অ্যাডমিনের নোট: ${note}` : ''}`,
      banglish: `Khushir khobor! Admin ${what ? `${what} e ` : 'apnar porer booking e '}${amount} discount approve koreche. Eta ${validUntil} porjonto valid, booking korle auto apply hoye jabe.${note ? ` Admin er note: ${note}` : ''}`,
    }[lang];
  }
  return {
    en: `Thank you for asking. Unfortunately an admin could not approve a discount${what ? ` for ${what}` : ''} this time.${note ? ` Reason: ${note}` : ''} You are welcome to ask again later.`,
    bn: `ধন্যবাদ জানানোর জন্য। দুঃখিত, এবার অ্যাডমিন${what ? ` ${what}-এর জন্য` : ''} ছাড় অনুমোদন করতে পারেননি।${note ? ` কারণ: ${note}` : ''} আপনি পরে আবার অনুরোধ করতে পারেন।`,
    banglish: `Request korar jonno dhonnobad. Dukkhito, ei bar admin${what ? ` ${what} er jonno` : ''} discount approve korte parenni.${note ? ` Karon: ${note}` : ''} Pore abar request korte paren.`,
  }[lang];
}

/**
 * @param {object} d  { language, decision: 'approved'|'declined', serviceName?, type?, value?, expiresAt?, note?, tz }
 * @returns {Promise<string>} the message to show the customer
 */
export async function composeDecisionReply(d) {
  const validUntil = d.expiresAt ? formatDate(d.expiresAt, d.tz) : 'further notice';
  const facts = { ...d, validUntil };

  if (isGeminiConfigured()) {
    try {
      const system = `You are Seba Assistant for a service booking app in Bangladesh. An admin has decided on a customer's discount request. Write the message telling the customer the decision.
Write it in ${LANGUAGE_NAMES[d.language] ?? LANGUAGE_NAMES.en}. Use 1 to 3 short, friendly sentences. Never use Bengali script when the language is Banglish. Never invent amounts or dates: use only the facts given. Write money as ৳ followed by the number. Output only the message text.`;
      const factsText = [
        `Decision: ${d.decision}`,
        d.serviceName ? `Service: ${d.serviceName}` : 'Service: any (applies to their next booking)',
        d.decision === 'approved' ? `Discount: ${describeDiscount(d.type, d.value)} off` : null,
        d.decision === 'approved' ? `Valid until: ${validUntil}` : null,
        d.decision === 'approved' ? 'It is applied automatically when they book.' : null,
        d.note ? `Admin note to mention: ${d.note}` : null,
      ]
        .filter(Boolean)
        .join('\n');
      const text = (await generateText(system, factsText)).trim();
      if (text) return text.slice(0, 900);
    } catch {
      // Fall through to the template.
    }
  }
  return template(facts);
}

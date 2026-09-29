// Listen & Learn: the teacher's practical-usage material for one curriculum
// entry. JH Medics Volume 1 gives the term, pinyin, English and meaning but no
// example sentences, so the Qwen teacher writes, once per entry:
//
//   sentence_zh  one short, natural Mandarin sentence that uses the EXACT term
//   sentence_en  its English translation
//   usage_en     where and how the term is used in medical situations
//   context_en   a short doctor / patient / interpreter situation
//
// The result is checked strictly (exact term in the sentence, short, one
// language per field) and stored in SQLite, so every later listen uses the
// same text and costs no extra quota. If Qwen is unavailable or its reply
// fails the checks twice, a plain template is used for this lesson only (not
// stored), and the next listen tries Qwen again. The curriculum itself is
// never changed.
import OpenAI from 'openai';
import { qwenSettings } from './teacher.js';

const HAN = /\p{Script=Han}/u;
const MAX_SENTENCE_CHARS = 40;
const MAX_ENGLISH_CHARS = 400;

export const LISTEN_WRITER_PROMPT = `You write listening material for Roy, an English-speaking medical interpreter learning medical Mandarin from the JH Medics Volume 1 curriculum.

You get one curriculum entry: English, Mandarin, pinyin and the JH Medics meaning. Write:
- sentence_zh: ONE short, natural Mandarin sentence (at most ${MAX_SENTENCE_CHARS} characters) that a doctor, nurse, patient or interpreter would really say in a hospital or clinic, and that contains the exact Mandarin term, character for character, unchanged. Use simple everyday words around it. Do not add other specialist medical terms. Chinese characters and Chinese punctuation only: no pinyin, no English.
- sentence_en: the English translation of that sentence. English only, no Chinese characters.
- usage_en: one or two short sentences, in English only, on where and how this term is actually used in medical situations (which situations, departments, conversations). Stay consistent with the JH Medics meaning; do not add facts that contradict it.
- context_en: one short sentence, in English only, describing a practical doctor/patient/interpreter situation where Roy would hear or need this term.

Keep everything about this one term. No unrelated vocabulary or everyday topics. Reply with one JSON object only: {"sentence_zh": "...", "sentence_en": "...", "usage_en": "...", "context_en": "..."}`;

// Problems with a generated item (empty list: usable).
export function checkListenContent(entry, c) {
  const problems = [];
  const term = String(entry.mandarin || '').trim();
  const field = (k) => (typeof c?.[k] === 'string' ? c[k].trim() : '');
  const zh = field('sentence_zh');
  if (!zh) problems.push('sentence_zh is missing');
  else {
    if (!zh.includes(term)) problems.push(`sentence_zh must contain the exact term ${term}`);
    if ([...zh].length > MAX_SENTENCE_CHARS) problems.push(`sentence_zh is longer than ${MAX_SENTENCE_CHARS} characters`);
    // Letters are allowed only where the term itself has them (e.g. X光片).
    if (/[A-Za-z]/.test(zh.split(term).join(''))) problems.push('sentence_zh must not contain pinyin or English');
  }
  for (const k of ['sentence_en', 'usage_en', 'context_en']) {
    const v = field(k);
    if (!v) problems.push(`${k} is missing`);
    else if (HAN.test(v)) problems.push(`${k} must be English only (no Chinese characters)`);
    else if (v.length > MAX_ENGLISH_CHARS) problems.push(`${k} is too long`);
  }
  return problems;
}

// Used when the teacher is unavailable: plain and always correct, uses the
// exact term, adds nothing beyond the curriculum entry.
export function templateContent(entry) {
  const english = String(entry.english || 'this term').trim();
  return {
    sentence_zh: `医生今天跟病人谈到了${String(entry.mandarin).trim()}。`,
    sentence_en: `Today the doctor talked with the patient about ${english}.`,
    usage_en: `You will hear this term when doctors, nurses and patients talk about ${english}.`,
    context_en: `As an interpreter, listen for this term whenever ${english} comes up in a consultation.`,
    source: 'template',
  };
}

export function createListenWriter({ client, env = process.env, log = console } = {}) {
  const q = qwenSettings(env);
  const configured = Boolean(client || q.apiKey);
  const api = configured ? client ?? new OpenAI({ apiKey: q.apiKey, baseURL: q.baseURL }) : null;
  return {
    configured,
    model: q.model,
    // Returns { content, source: 'teacher' | 'template' }.
    async write(entry) {
      if (!configured) return { content: templateContent(entry), source: 'template' };
      const facts = { english: entry.english, mandarin: entry.mandarin, pinyin: entry.pinyin || null, jh_medics_meaning: entry.meaning ?? null };
      const messages = [
        { role: 'system', content: LISTEN_WRITER_PROMPT },
        { role: 'user', content: JSON.stringify(facts) },
      ];
      for (let attempt = 1; attempt <= 2; attempt++) {
        let text = '';
        try {
          log.log(`[listen] -> Qwen example for word ${entry.position} (${entry.mandarin}) attempt ${attempt}`);
          const completion = await api.chat.completions.create({ model: q.model, max_tokens: 800, response_format: { type: 'json_object' }, enable_thinking: q.enableThinking, messages });
          text = completion.choices?.[0]?.message?.content ?? '';
          const parsed = JSON.parse(text);
          const problems = checkListenContent(entry, parsed);
          if (!problems.length) {
            const content = Object.fromEntries(['sentence_zh', 'sentence_en', 'usage_en', 'context_en'].map((k) => [k, parsed[k].trim()]));
            return { content: { ...content, source: 'teacher' }, source: 'teacher' };
          }
          log.warn(`[listen]    example for word ${entry.position} rejected: ${problems.join('; ')}`);
          messages.push({ role: 'assistant', content: text }, { role: 'user', content: `That reply is not usable: ${problems.join('; ')}. Send the corrected JSON object only.` });
        } catch (err) {
          log.warn(`[listen]    example for word ${entry.position} failed: ${err.message}`);
          if (err instanceof OpenAI.APIError) break; // no point retrying a rejected request
          if (text) messages.push({ role: 'assistant', content: text }, { role: 'user', content: 'That was not valid JSON. Send the JSON object only.' });
        }
      }
      return { content: templateContent(entry), source: 'template' };
    },
  };
}

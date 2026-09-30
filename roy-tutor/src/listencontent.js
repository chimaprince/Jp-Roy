// Listen & Learn: the AI teacher's teaching layer for one curriculum entry.
// JH Medics Volume 1 is the source of truth for the term, its pinyin, English,
// medical meaning and order, but it has no explanations or example sentences.
// So the Qwen teacher writes, once per entry (server-side):
//
//   explanation_en  1-2 sentences: what the term means in medical
//                   communication, built on the JH Medics meaning
//   usage_en        where and how the term is actually used (practical usage)
//   sentence_zh     one short, natural Mandarin sentence with the EXACT term
//   sentence_en     its English translation
//   context_en      a practical situation where an interpreter hears/uses it
//   dialogue        optional: 2-4 lines of a short doctor/patient/nurse/
//                   interpreter exchange ({speaker, zh, en}), only when useful
//
// The result is checked strictly (exact term in the sentence, short, one
// language per field; a dialogue that fails its checks is dropped) and stored
// in SQLite, so every later listen uses the same text and costs no extra
// quota. If Qwen is unavailable or its reply fails the checks twice, a plain
// template is used for this lesson only (not stored), and the next listen
// tries Qwen again. The curriculum itself is never changed, and nothing the
// teacher wrote is presented as coming from JH Medics.
import OpenAI from 'openai';
import { qwenSettings, qwenClient } from './teacher.js';

const HAN = /\p{Script=Han}/u;
const MAX_SENTENCE_CHARS = 40;
const MAX_ENGLISH_CHARS = 400;
const MAX_DIALOGUE_LINES = 4;
export const SPEAKERS = ['医生', '患者', '护士', '翻译', '家属'];
// Version of the stored material; older stored items are rewritten once.
export const CONTENT_VERSION = 2;
const ENGLISH_FIELDS = ['explanation_en', 'usage_en', 'sentence_en', 'context_en'];

export const LISTEN_WRITER_PROMPT = `You are Roy's medical Mandarin teacher. Roy is an English-speaking medical interpreter learning medical Mandarin from the JH Medics Volume 1 curriculum. You write the teaching layer for one curriculum entry, which Roy will hear as an audio lesson.

You get one entry: English, Mandarin, pinyin and the JH Medics meaning. The entry is the source of truth: never change or correct it. JH Medics has no examples, so the explanation and examples are yours; keep them medically sound and consistent with the JH Medics meaning, and do not invent unsupported medical facts. Stay in medical communication (hospital, clinic, doctor, patient, nurse, interpreter). If the term is broad, say so briefly.

Write one JSON object with:
- explanation_en: one or two short sentences, English only: what this term means in medical communication, built on the JH Medics meaning.
- usage_en: one or two short sentences, English only: where and how the term is actually used (which situations, departments, conversations).
- sentence_zh: ONE short, natural Mandarin sentence (at most ${MAX_SENTENCE_CHARS} characters) that a doctor, nurse, patient or interpreter would really say, containing the exact Mandarin term, character for character. Simple everyday words around it; no other specialist terms. Chinese characters and Chinese punctuation only: no pinyin, no English.
- sentence_en: its English translation. English only.
- context_en: one short sentence, English only: a practical situation where Roy, as an interpreter, would hear or need this term.
- dialogue: a short exchange ONLY when it genuinely helps (otherwise []): 2 to ${MAX_DIALOGUE_LINES} lines, each {"speaker": one of ${SPEAKERS.join(' / ')}, "zh": a short Mandarin line (Chinese only, at most ${MAX_SENTENCE_CHARS} characters), "en": its English translation}. At least one line contains the exact term.

Reply with the JSON object only: {"explanation_en": "...", "usage_en": "...", "sentence_zh": "...", "sentence_en": "...", "context_en": "...", "dialogue": []}`;

const text = (v) => (typeof v === 'string' ? v.trim() : '');
const chineseOnly = (zh, term) => !/[A-Za-z]/.test(zh.split(term).join('')); // letters only where the term has them (e.g. X光片)

// Problems with a generated item (empty list: usable). The dialogue is
// optional and checked separately (see cleanDialogue).
export function checkListenContent(entry, c) {
  const problems = [];
  const term = String(entry.mandarin || '').trim();
  const zh = text(c?.sentence_zh);
  if (!zh) problems.push('sentence_zh is missing');
  else {
    if (!zh.includes(term)) problems.push(`sentence_zh must contain the exact term ${term}`);
    if ([...zh].length > MAX_SENTENCE_CHARS) problems.push(`sentence_zh is longer than ${MAX_SENTENCE_CHARS} characters`);
    if (!chineseOnly(zh, term)) problems.push('sentence_zh must not contain pinyin or English');
  }
  for (const k of ENGLISH_FIELDS) {
    const v = text(c?.[k]);
    if (!v) problems.push(`${k} is missing`);
    else if (HAN.test(v)) problems.push(`${k} must be English only (no Chinese characters)`);
    else if (v.length > MAX_ENGLISH_CHARS) problems.push(`${k} is too long`);
  }
  return problems;
}

// The dialogue if every line is usable, else [] (a lesson without a dialogue
// is fine; a wrong one is not).
export function cleanDialogue(entry, dialogue) {
  if (!Array.isArray(dialogue) || dialogue.length < 2 || dialogue.length > MAX_DIALOGUE_LINES) return [];
  const term = String(entry.mandarin || '').trim();
  const lines = dialogue.map((l) => ({ speaker: text(l?.speaker), zh: text(l?.zh), en: text(l?.en) }));
  const ok = lines.every((l) => SPEAKERS.includes(l.speaker) && l.zh && l.en && [...l.zh].length <= MAX_SENTENCE_CHARS
    && chineseOnly(l.zh, term) && HAN.test(l.zh) && !HAN.test(l.en) && l.en.length <= MAX_ENGLISH_CHARS);
  return ok && lines.some((l) => l.zh.includes(term)) ? lines : [];
}

// Used when the teacher is unavailable: plain and always correct, uses the
// exact term, adds nothing beyond the curriculum entry.
export function templateContent(entry) {
  const english = String(entry.english || 'this term').trim();
  const meaning = String(entry.meaning || '').trim();
  return {
    v: CONTENT_VERSION,
    explanation_en: meaning ? `JH Medics defines it as: ${meaning}` : `It means ${english}.`,
    usage_en: `You will hear this term when doctors, nurses and patients talk about ${english}.`,
    sentence_zh: `医生今天跟病人谈到了${String(entry.mandarin).trim()}。`,
    sentence_en: `Today the doctor talked with the patient about ${english}.`,
    context_en: `As an interpreter, listen for this term whenever ${english} comes up in a consultation.`,
    dialogue: [],
    source: 'template',
  };
}

// Stored material from before explanations and dialogues existed (version 1).
export const isCurrent = (c) => c?.v === CONTENT_VERSION;

export function createListenWriter({ client, env = process.env, log = console } = {}) {
  const q = qwenSettings(env);
  const configured = Boolean(client || q.apiKey);
  const api = configured ? client ?? qwenClient(q) : null;
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
          const completion = await api.chat.completions.create({ model: q.model, max_tokens: 1200, response_format: { type: 'json_object' }, enable_thinking: q.enableThinking, messages });
          text = completion.choices?.[0]?.message?.content ?? '';
          const parsed = JSON.parse(text);
          const problems = checkListenContent(entry, parsed);
          if (!problems.length) {
            const content = Object.fromEntries(['sentence_zh', ...ENGLISH_FIELDS].map((k) => [k, parsed[k].trim()]));
            const dialogue = cleanDialogue(entry, parsed.dialogue);
            if (Array.isArray(parsed.dialogue) && parsed.dialogue.length && !dialogue.length) log.warn(`[listen]    dialogue for word ${entry.position} dropped (did not pass the checks)`);
            return { content: { v: CONTENT_VERSION, ...content, dialogue, source: 'teacher' }, source: 'teacher' };
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

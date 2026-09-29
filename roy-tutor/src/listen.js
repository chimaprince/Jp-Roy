// Listen & Learn: a spoken lesson for one curriculum entry. Roy only listens;
// nothing is asked and nothing is recorded, so the microphone is never used.
//
// From the curriculum (JH Medics Volume 1 is the source of truth): the term,
// its pinyin, the English and the medical meaning. From the teacher (written
// once per entry by Qwen, checked, stored; see listencontent.js): a natural
// sentence using the exact term, its English translation, where the term is
// used, and a doctor/patient/interpreter situation. Each step says where its
// text comes from.
//
// Every line is spoken by Qwen TTS on the server. Mandarin lines contain only
// Chinese, so the voice reads them as Mandarin; pinyin is never sent to TTS (a
// Mandarin voice reads letters oddly): it is shown on screen while the voice
// says the characters. English lines contain only English.
//
// Order: the term; slowly with pinyin on screen; English; medical meaning;
// syllable by syllable (only when each character has one reading, so the voice
// cannot pick a wrong one); where it is used; an example sentence; its
// translation; a practical situation; the term once more.
import { polyphonic } from 'pinyin-pro';

const HAN = /\p{Script=Han}/u;

// Split the term into characters and the curriculum pinyin into syllables;
// null when they do not line up one-to-one.
function syllablePairs(entry) {
  const chars = [...String(entry.mandarin || '')].filter((c) => HAN.test(c));
  const syllables = String(entry.pinyin || '').split(/[\s/,()（）-]+/).filter((s) => /\p{L}/u.test(s));
  if (chars.length < 2 || chars.length !== syllables.length) return null;
  return chars.map((char, i) => ({ char, syllable: syllables[i] }));
}

const singleReading = (char) => (polyphonic(char, { type: 'array' })[0] ?? []).length === 1;

// Kinds of step that must be in every lesson (tests check these).
export const REQUIRED_STEPS = ['term', 'pinyin', 'english', 'meaning', 'usage', 'sentence', 'sentence-en', 'context', 'repeat'];

/**
 * @param entry    curriculum entry
 * @param total    number of entries in the course
 * @param content  { sentence_zh, sentence_en, usage_en, context_en, source: 'teacher'|'template' }
 */
export function listenLesson(entry, total, content) {
  const term = String(entry.mandarin || '').trim();
  const pinyin = String(entry.pinyin || '').trim();
  const english = String(entry.english || '').trim();
  const meaning = String(entry.meaning || '').trim();
  const from = content?.source === 'teacher' ? 'teacher' : 'template';
  const steps = [];
  const add = (kind, lang, text, show, source, extra = {}) => { if (text) steps.push({ kind, lang, text, show, source, ...extra }); };
  const withPinyin = pinyin ? `${term}  ${pinyin}` : `${term}  (no pinyin in the source)`;

  add('intro', 'en', `Word ${entry.position} of ${total}.`, `Word ${entry.position} of ${total}`, 'curriculum');
  add('term', 'zh', term, withPinyin, 'curriculum');
  add('pinyin', 'zh', term, withPinyin, 'curriculum', { rate: 0.8 });
  add('english', 'en', english ? `In English: ${english}.` : 'In English: not given in the source.', english || '(no English in the source)', 'curriculum');
  add('meaning', 'en', meaning ? `The medical meaning, from JH Medics: ${meaning}` : 'JH Medics gives no meaning for this term.', meaning || '(no meaning in the source)', 'curriculum');
  const pairs = syllablePairs(entry);
  if (pairs && pairs.every((p) => singleReading(p.char))) {
    const shown = pairs.map((p) => `${p.char} ${p.syllable}`).join(' · ');
    add('breakdown-intro', 'en', 'Syllable by syllable.', shown, 'curriculum');
    add('breakdown', 'zh', pairs.map((p) => p.char).join('，'), shown, 'curriculum', { rate: 0.8 });
  }
  add('usage', 'en', `Where you will hear it: ${content.usage_en}`, content.usage_en, from);
  add('sentence-intro', 'en', 'For example:', content.sentence_zh, from);
  add('sentence', 'zh', content.sentence_zh, content.sentence_zh, from);
  add('sentence-en', 'en', `That means: ${content.sentence_en}`, `${content.sentence_zh}\n${content.sentence_en}`, from);
  add('context', 'en', `In practice: ${content.context_en}`, content.context_en, from);
  add('repeat-intro', 'en', english ? `Once more, ${english}:` : 'Once more:', withPinyin, 'curriculum');
  add('repeat', 'zh', term, withPinyin, 'curriculum', { rate: 0.9 });

  return {
    position: entry.position,
    total,
    card: { position: entry.position, mandarin: entry.mandarin, pinyin: entry.pinyin || null, english: entry.english, meaning: entry.meaning ?? null, sourcePage: entry.source_page ?? null },
    example: { sentence_zh: content.sentence_zh, sentence_en: content.sentence_en, source: from },
    steps,
  };
}

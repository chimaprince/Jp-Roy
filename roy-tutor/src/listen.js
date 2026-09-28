// Listen & Learn: a spoken lesson for one curriculum entry. Roy only listens;
// nothing is asked and nothing is recorded, so the microphone is never used.
//
// The script is built from the curriculum entry itself (JH Medics Volume 1 is
// the source of truth): no AI-generated content, no extra vocabulary. Every
// line is spoken by Qwen TTS on the server; the page only plays the audio.
//
// Mandarin lines contain only Chinese characters, so the voice reads them as
// Mandarin. Pinyin is never sent to TTS (a Mandarin voice would read the
// letters oddly): it is shown on screen while the voice says the characters.
// English lines contain only English, so they are read in English.
//
// Steps: the term; the term again slowly with the pinyin on screen; the
// English; the JH Medics meaning; syllable by syllable (only when every
// character has a single reading, so the voice cannot pick a wrong one); the
// term once more. Volume 1 has no example sentences, so there is no sentence
// step (the sentence exercise in Interactive Practice covers sentences).
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

export function listenLesson(entry, total) {
  const term = String(entry.mandarin || '').trim();
  const pinyin = String(entry.pinyin || '').trim();
  const english = String(entry.english || '').trim();
  const meaning = String(entry.meaning || '').trim();
  const steps = [];
  const add = (kind, lang, text, show, extra = {}) => { if (text) steps.push({ kind, lang, text, show, ...extra }); };

  add('intro', 'en', `Word ${entry.position} of ${total}.`, `Word ${entry.position} of ${total}`);
  add('term', 'zh', term, term);
  add('pinyin', 'zh', term, pinyin ? `${term}  ${pinyin}` : `${term}  (no pinyin in the source)`, { rate: 0.8 });
  add('english', 'en', english ? `In English: ${english}.` : '', english);
  add('meaning', 'en', meaning ? `The medical meaning, from JH Medics: ${meaning}` : '', meaning);
  const pairs = syllablePairs(entry);
  if (pairs && pairs.every((p) => singleReading(p.char))) {
    add('breakdown-intro', 'en', 'Syllable by syllable.', pairs.map((p) => `${p.char} ${p.syllable}`).join(' · '));
    add('breakdown', 'zh', pairs.map((p) => p.char).join('，'), pairs.map((p) => `${p.char} ${p.syllable}`).join(' · '), { rate: 0.8 });
  }
  add('repeat', 'zh', term, pinyin ? `${term}  ${pinyin}` : term);
  add('end', 'en', `That was ${english || 'this word'}.`, english ? `${term} = ${english}` : term);

  return {
    position: entry.position,
    total,
    card: { position: entry.position, mandarin: entry.mandarin, pinyin: entry.pinyin || null, english: entry.english, meaning: entry.meaning ?? null, sourcePage: entry.source_page ?? null },
    steps,
  };
}

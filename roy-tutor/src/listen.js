// Listen & Learn: a spoken lesson for one curriculum entry. Roy only listens;
// nothing is asked and nothing is recorded, so the microphone is never used.
// The same lesson structure for every course (JH Medics Volume 1 or any other
// document): only the entries change.
//
// From the course document (the source of truth): the item (a word, phrase or
// sentence), its pinyin, the English and the meaning. From the AI teacher
// (written once per entry by Qwen, checked, stored; see listencontent.js): a
// short explanation, practical usage, a natural sentence using the exact term
// and its translation, an interpreter situation and, when useful, a short
// doctor/patient exchange. Each step says where its text comes from.
//
// Every line is spoken by Qwen TTS on the server. Mandarin lines contain only
// Chinese, so the voice reads them as Mandarin; pinyin is never sent to TTS (a
// Mandarin voice reads letters oddly): it is shown on screen while the voice
// says the characters. English lines contain only English.
//
// A lesson is a few natural segments (7 to 9), not one line per field, so a
// word costs 6 to 8 TTS requests, each made once and cached:
//
//   1 intro      "我们来学一个医学词语：硬膜外。" (Mandarin)
//   2 term       the Mandarin term, slowly (pinyin on screen, never spoken)
//   3 explain    "Epidural. <what it means> <where it is used> For example:"
//   4 sentence   the Mandarin example sentence
//   5 sentence-en "That means: <translation>. <interpreter situation>"
//   6 dialogue / dialogue-en   a short exchange, only when the teacher wrote one
//   7 recap      "再听一次：硬膜外。<the example sentence>" (Mandarin)
//
// When the last segment's audio has really ended, the player records the word
// and moves on to the next word by itself (see ListenController).

// Kinds of step that must be in every lesson (tests check these).
export const REQUIRED_STEPS = ['intro', 'term', 'explain', 'sentence', 'sentence-en', 'recap'];
// A review lesson (start of a new study day) is the short version.
export const REVIEW_STEPS = ['intro', 'term', 'explain', 'sentence', 'sentence-en', 'recap'];

const HAN = /\p{Script=Han}/u;
const SPEAKER_EN = { 医生: 'Doctor', 患者: 'Patient', 护士: 'Nurse', 翻译: 'Interpreter', 家属: 'Family member' };
const sentenceEnd = (t) => (/[.!?]$/.test(t) ? t : `${t}.`);

/**
 * @param entry    curriculum entry
 * @param total    number of entries in the course
 * @param content  { explanation_en, usage_en, sentence_zh, sentence_en, context_en, dialogue, source }
 * @param review   true: the short review version
 */
export function listenLesson(entry, total, content, { review = false } = {}) {
  const term = String(entry.mandarin || '').trim();
  const pinyin = String(entry.pinyin || '').trim();
  const english = String(entry.english || '').trim();
  const from = content?.source === 'teacher' ? 'teacher' : 'template';
  const dialogue = review ? [] : (Array.isArray(content.dialogue) ? content.dialogue : []);
  const steps = [];
  const add = (kind, lang, text, show, source, extra = {}) => { if (text) steps.push({ kind, lang, text, show, source, ...extra }); };
  const withPinyin = pinyin ? `${term}  ${pinyin}` : `${term}  (no pinyin in the source)`;
  const English = english ? english[0].toUpperCase() + english.slice(1) : '';
  // A word is introduced as a word; a phrase or sentence from the document as one.
  const phrase = [...term].filter((c) => HAN.test(c)).length > 6 || /[，。？！、；：]/.test(term);
  const what = phrase ? '一句医学用语' : '一个医学词语';
  const said = /[。！？.!?]$/.test(term) ? term : `${term}。`; // no doubled full stop after a sentence item
  add('intro', 'zh', review ? `复习${what}：${said}` : `我们来学${what}：${said}`, withPinyin, 'curriculum');
  add('term', 'zh', term, withPinyin, 'curriculum', { rate: 0.8 });
  if (review) {
    add('explain', 'en', `Review. ${English ? sentenceEnd(English) : ''} For example:`.replace(/\s+/g, ' '), english || '(no English in the source)', 'curriculum');
  } else {
    add('explain', 'en', [English && sentenceEnd(English), content.explanation_en, content.usage_en, 'For example:'].filter(Boolean).join(' '),
      [english || '(no English in the source)', content.explanation_en, content.usage_en].filter(Boolean).join('\n\n'), from);
  }
  add('sentence', 'zh', content.sentence_zh, content.sentence_zh, from);
  const tail = dialogue.length ? 'Here is a short conversation.' : null;
  add('sentence-en', 'en', [`That means: ${sentenceEnd(content.sentence_en)}`, review ? null : content.context_en, tail].filter(Boolean).join(' '),
    [content.sentence_zh, content.sentence_en, review ? null : content.context_en].filter(Boolean).join('\n\n'), from);
  if (dialogue.length) {
    const shown = dialogue.map((l) => `${l.speaker}：${l.zh}\n${SPEAKER_EN[l.speaker] ?? l.speaker}: ${l.en}`).join('\n');
    add('dialogue', 'zh', dialogue.map((l) => `${l.speaker}：${l.zh}`).join(' '), shown, from);
    add('dialogue-en', 'en', dialogue.map((l) => `${SPEAKER_EN[l.speaker] ?? l.speaker}: ${sentenceEnd(l.en)}`).join(' '), shown, from);
  }
  add('recap', 'zh', `再听一次：${said}${content.sentence_zh}`, `${withPinyin}\n${content.sentence_zh}`, from, { rate: 0.9 });

  return {
    position: entry.position,
    total,
    card: { position: entry.position, mandarin: entry.mandarin, pinyin: entry.pinyin || null, english: entry.english, meaning: entry.meaning ?? null, sourcePage: entry.source_page ?? null },
    // The teaching layer as structured data (what the steps are made from).
    teaching: {
      source: from,
      explanation_en: content.explanation_en ?? null,
      usage_en: content.usage_en ?? null,
      sentence_zh: content.sentence_zh,
      sentence_en: content.sentence_en,
      context_en: content.context_en ?? null,
      dialogue,
    },
    example: { sentence_zh: content.sentence_zh, sentence_en: content.sentence_en, source: from },
    steps,
  };
}

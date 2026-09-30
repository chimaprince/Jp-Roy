// Listen & Learn: a spoken lesson for one curriculum entry. Roy only listens;
// nothing is asked and nothing is recorded, so the microphone is never used.
//
// From the curriculum (JH Medics Volume 1 is the source of truth): the term,
// its pinyin, the English and the medical meaning. From the AI teacher
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
// A lesson is a few natural segments (5 to 7), not one line per field, so a
// word costs only 4 to 6 TTS requests; the term at the start and at the end is
// the same audio (cached):
//
//   1 term       the Mandarin term, slowly (pinyin on screen)
//   2 explain    "Epidural. <what it means> <where it is used> For example:"
//   3 sentence   the Mandarin example sentence
//   4 sentence-en "That means: <translation>. <interpreter situation>"
//   5 dialogue / dialogue-en   a short exchange, only when the teacher wrote one
//   6 repeat     the term once more, slowly
//
// Then the player moves on to the next word by itself (see ListenController).

// Kinds of step that must be in every lesson (tests check these).
export const REQUIRED_STEPS = ['term', 'explain', 'sentence', 'sentence-en', 'repeat'];
// A review lesson (start of a new study day) is the short version.
export const REVIEW_STEPS = ['term', 'explain', 'sentence', 'sentence-en', 'repeat'];

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
  const onceMore = 'Once more:';

  add('term', 'zh', term, withPinyin, 'curriculum', { rate: 0.8 });
  if (review) {
    add('explain', 'en', `Review. ${English ? sentenceEnd(English) : ''} For example:`.replace(/\s+/g, ' '), english || '(no English in the source)', 'curriculum');
  } else {
    add('explain', 'en', [English && sentenceEnd(English), content.explanation_en, content.usage_en, 'For example:'].filter(Boolean).join(' '),
      [english || '(no English in the source)', content.explanation_en, content.usage_en].filter(Boolean).join('\n\n'), from);
  }
  add('sentence', 'zh', content.sentence_zh, content.sentence_zh, from);
  const tail = dialogue.length ? 'Here is a short conversation.' : onceMore;
  add('sentence-en', 'en', [`That means: ${sentenceEnd(content.sentence_en)}`, review ? null : content.context_en, tail].filter(Boolean).join(' '),
    [content.sentence_zh, content.sentence_en, review ? null : content.context_en].filter(Boolean).join('\n\n'), from);
  if (dialogue.length) {
    const shown = dialogue.map((l) => `${l.speaker}：${l.zh}\n${SPEAKER_EN[l.speaker] ?? l.speaker}: ${l.en}`).join('\n');
    add('dialogue', 'zh', dialogue.map((l) => `${l.speaker}：${l.zh}`).join(' '), shown, from);
    add('dialogue-en', 'en', `${dialogue.map((l) => `${SPEAKER_EN[l.speaker] ?? l.speaker}: ${sentenceEnd(l.en)}`).join(' ')} ${onceMore}`, shown, from);
  }
  add('repeat', 'zh', term, withPinyin, 'curriculum', { rate: 0.8 });

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

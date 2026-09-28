// ASR-aware answer evaluation: the recogniser's transcript is evidence, not
// ground truth. Real iPhone case: Roy said 硬膜外 (yìng mó wài) correctly and
// Qwen ASR wrote 硬磨外 (磨 is also mó).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getProgress, getEntryProgress, activeCourse, entryAt } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';
import { evaluateSpokenTerm, numberedSyllable, LEVELS } from '../src/evaluation.js';

const EPIDURAL = { position: 1, english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: "Injection of a substance into a person's spine", source_page: '1' };
const FIXTURE = [
  EPIDURAL,
  { position: 2, english: 'esophagus', mandarin: '食道', pinyin: 'shí dào', meaning: 'The tube to the stomach', source_page: '1' },
];

// ---------- the evaluation itself ----------

test('expected 膜, ASR 磨: a recogniser character mismatch, not a wrong answer', () => {
  const r = evaluateSpokenTerm(EPIDURAL, '硬磨外');
  assert.equal(r.level, 'likely_correct_asr_character_mismatch');
  const mo = r.characters[1];
  assert.equal(mo.expected, '膜');
  assert.equal(mo.heard, '磨');
  assert.equal(mo.expected_syllable, 'mo2');
  assert.ok(mo.heard_readings.includes('mo2'), '磨 can be read mó');
  assert.equal(mo.match, 'same_sound');
  assert.match(r.explanation, /磨 for 膜 \(both mo2\)/);
  assert.match(r.explanation, /not evidence of a mispronunciation/);
  // The same inside a longer transcript, with punctuation.
  assert.equal(evaluateSpokenTerm(EPIDURAL, '我说：硬磨外。').level, 'likely_correct_asr_character_mismatch');
});

test('the four confidence levels', () => {
  assert.deepEqual(LEVELS, ['high_confidence_correct', 'likely_correct_asr_character_mismatch', 'uncertain', 'clearly_incorrect']);
  const level = (t) => evaluateSpokenTerm(EPIDURAL, t).level;
  assert.equal(level('硬膜外'), 'high_confidence_correct');
  assert.equal(level('应模外'), 'likely_correct_asr_character_mismatch', 'every syllable same sound and tone');
  assert.equal(level('硬摸外'), 'uncertain', '摸 is mō: same syllable, different tone');
  assert.equal(level('营膜外'), 'uncertain', '营 is yíng: tone differs');
  assert.equal(level('yingmowai'), 'uncertain', 'pinyin letters only');
  assert.equal(level('硬书外'), 'uncertain', 'one syllable of three not recognised');
});

test('clearly wrong answers are still detected; knowing the answer never makes them right', () => {
  const level = (t) => evaluateSpokenTerm(EPIDURAL, t).level;
  assert.equal(level('食道'), 'clearly_incorrect', 'a different word');
  assert.equal(level('你好'), 'clearly_incorrect');
  assert.equal(level('硬外'), 'clearly_incorrect', 'a missing syllable');
  assert.equal(level('epidural'), 'clearly_incorrect', 'English instead of Mandarin');
  assert.equal(level(''), 'clearly_incorrect');
  assert.equal(level('书书书'), 'clearly_incorrect');
  assert.equal(evaluateSpokenTerm(EPIDURAL, 'epidural').english_term_mentioned, true);
});

test('pinyin from the curriculum is read with tones (ü, neutral tone)', () => {
  assert.deepEqual(['yìng', 'mó', 'wài', 'lǜ', 'de', 'nǚ'].map(numberedSyllable), ['ying4', 'mo2', 'wai4', 'lv4', 'de5', 'nv3']);
  const r = evaluateSpokenTerm({ mandarin: '食道', pinyin: 'shí dào' }, '食道');
  assert.deepEqual(r.expected_syllables, ['shi2', 'dao4']);
  assert.equal(r.syllables_from, 'curriculum pinyin');
  const noPinyin = evaluateSpokenTerm({ mandarin: '心电图', pinyin: '' }, '心电图');
  assert.equal(noPinyin.syllables_from, 'dictionary reading of the term');
  assert.equal(noPinyin.level, 'high_confidence_correct');
});

// ---------- the engine uses it ----------

function decision(over = {}) {
  return {
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'Teacher reply.', show: null, slow: false }], notes: '', ...over,
  };
}

function setup() {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  importEntries(db, 'vol1', FIXTURE);
  const queue = [];
  const contexts = [];
  const teacher = { configured: true, contexts, next: (...d) => queue.push(...d), async decide(ctx) { contexts.push(ctx); return queue.shift() ?? decision(); } };
  const tutor = new Tutor({ db, teacher, now: () => new Date('2026-09-28T10:00:00') });
  return { db, tutor, teacher };
}
const voice = { source: 'voice', language: 'zh-CN' };
const lesson = (db) => ({ entry: getEntryProgress(db, 'roy', entryAt(db, 'vol1', 1).id), progress: getProgress(db, 'roy', activeCourse(db).id) });

test('correct pronunciation with a character mismatch is not failed, and the teacher is told why', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: true, exercise_complete: true, next_action: 'next_exercise', speech: [{ lang: 'en', text: 'Good, I heard the word. The recogniser wrote 磨, but the character in our medical term is 膜.', show: null, slow: false }] }));
  const r = await tutor.message('硬磨外', voice);
  const ev = teacher.contexts.at(-1).roy_said.asr_evaluation;
  assert.equal(ev.level, 'likely_correct_asr_character_mismatch');
  assert.match(ev.how_to_respond, /Do NOT say he mispronounced/);
  assert.match(ev.how_to_respond, /what the recogniser transcribed/);
  assert.equal(r.exercise, 'meaning', 'the pronounce exercise completed');
});

test('if the teacher marks a character mismatch wrong, it is asked again, and it never counts as a mistake', async () => {
  const { db, tutor, teacher } = setup();
  await tutor.start();
  // First reply wrongly calls it a mistake; the second still does.
  teacher.next(decision({ correct: false }), decision({ correct: false }));
  const r = await tutor.message('硬磨外', voice);
  assert.equal(teacher.contexts.length, 3, 'start + reply + one re-ask');
  assert.match(teacher.contexts.at(-1).engine_check, /only the recogniser's characters differ/);
  assert.equal(r.exercise, 'pronounce', 'not completed either');
  const s = tutor.status().session;
  assert.equal(s.exercise, 'pronounce');
  // Two real mistakes would make the word weak; mismatches must not count.
  teacher.next(decision({ correct: false }), decision({ correct: false }));
  await tutor.message('硬磨外', voice);
  teacher.next(decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }));
  await tutor.message('硬膜外', voice);
  const ctx = teacher.contexts.at(-1);
  assert.equal(ctx.lesson_state.wrong_attempts_this_exercise, 0, 'no mistakes were counted');
  assert.equal(lesson(db).entry.weak, 0);
});

test('a clearly wrong answer is never completed, even if the teacher says correct', async () => {
  const { db, tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }), decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }));
  const r = await tutor.message('食道', voice);
  assert.equal(teacher.contexts.at(-2).roy_said.asr_evaluation.level, 'clearly_incorrect');
  assert.match(teacher.contexts.at(-1).engine_check, /must not be marked correct/);
  assert.equal(r.exercise, 'pronounce', 'still on the same exercise');
  assert.equal(teacher.contexts.at(-1).lesson_state.wrong_attempts_this_exercise, 0);
  const next = await tutor.message('硬膜外', voice); // default decision: not complete
  assert.equal(teacher.contexts.at(-1).lesson_state.wrong_attempts_this_exercise, 1, 'counted as a wrong attempt');
  assert.equal(next.exercise, 'pronounce');
  assert.equal(lesson(db).progress.current_position, 1, 'progress unchanged');
  assert.equal(lesson(db).entry.completed, 0);
});

test('a clearly wrong answer the teacher also calls wrong: no re-ask, counted as a mistake', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: false, needs_retry: true }));
  await tutor.message('你好', voice);
  assert.equal(teacher.contexts.length, 2, 'no extra teacher call');
  await tutor.message('硬膜外', voice);
  assert.equal(teacher.contexts.at(-1).lesson_state.wrong_attempts_this_exercise, 1);
});

test('uncertain evidence is left to the teacher (no forced verdict either way)', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: null, needs_retry: true }));
  const r = await tutor.message('硬摸外', voice);
  const ev = teacher.contexts.at(-1).roy_said.asr_evaluation;
  assert.equal(ev.level, 'uncertain');
  assert.match(ev.how_to_respond, /did not quite catch it/);
  assert.equal(teacher.contexts.length, 2);
  assert.equal(r.exercise, 'pronounce');
});

test('in a sentence exercise the evaluation only says whether the term was used', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }), decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }));
  await tutor.message('硬膜外', voice);
  await tutor.message('an injection into the spine', { source: 'voice', language: 'en-US' });
  assert.equal(teacher.contexts.at(-1).roy_said.asr_evaluation, null, 'English meaning answers are not compared with Mandarin');
  teacher.next(decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' }));
  const r = await tutor.message('医生说我们需要打硬磨外。', voice);
  const ev = teacher.contexts.at(-1).roy_said.asr_evaluation;
  assert.match(ev.applies_to, /whether the term appears/);
  assert.equal(ev.level, 'likely_correct_asr_character_mismatch');
  assert.equal(r.exercise, 'roleplay', 'role-play still follows the sentence');
});

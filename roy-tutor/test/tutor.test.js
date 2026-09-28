import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getProgress, getEntryProgress, activeCourse, entryAt } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';
import { createTeacher, qwenSettings, checkDecision, normalizeDecision, DECISION_SCHEMA, INTENTS, QWEN_DEFAULT_MODEL, QWEN_DEFAULT_BASE_URL } from '../src/teacher.js';

// These tests cover the tutor engine: lesson state, order, progress, and what
// it sends to the AI teacher. The teacher is replaced by a stand-in that
// returns fixed decisions, so they do NOT test the AI's judgement.

const FIXTURE = [
  { position: 1, english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: "Injection of a substance into a person's spine", source_page: '1' },
  { position: 2, english: 'test term two', mandarin: '测试二', pinyin: 'cè shì èr', meaning: 'placeholder two', source_page: '1' },
  { position: 3, english: 'test term three', mandarin: '测试三', pinyin: 'cè shì sān', meaning: 'placeholder three', source_page: '1' },
];

function decision(over = {}) {
  return {
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'Teacher reply.', show: null, slow: false }], notes: '', ...over,
  };
}

function fakeTeacher() {
  const queue = [];
  const contexts = [];
  return {
    configured: true,
    contexts,
    next(...ds) { queue.push(...ds); },
    async decide(ctx) {
      contexts.push(ctx);
      return queue.shift() ?? decision();
    },
  };
}

function setup() {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  assert.ok(importEntries(db, 'vol1', FIXTURE).ok);
  let clock = new Date('2026-09-27T10:00:00');
  const teacher = fakeTeacher();
  const tutor = new Tutor({ db, teacher, now: () => clock });
  return { db, teacher, tutor, setClock: (d) => { clock = new Date(d); } };
}

const voice = { source: 'voice', alternatives: [], confidence: 0.9 };
const done = (over = {}) => decision({ correct: true, exercise_complete: true, next_action: 'next_exercise', ...over });
const last = (teacher) => teacher.contexts.at(-1);

async function passWord(tutor, teacher, entry) {
  teacher.next(done(), done(), done(), done());
  await tutor.message(entry.mandarin, voice);
  await tutor.message(entry.english, { source: 'voice' });
  await tutor.message(`这是${entry.mandarin}。`, voice);
  return tutor.message(entry.mandarin, voice);
}

test('without DASHSCOPE_API_KEY the tutor refuses to run and says Qwen is not configured', async () => {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  importEntries(db, 'vol1', FIXTURE);
  const teacher = createTeacher({ env: {} });
  assert.equal(teacher.configured, false);
  const tutor = new Tutor({ db, teacher });
  assert.equal(tutor.status().aiConfigured, false);
  await assert.rejects(() => tutor.start(), (err) => err.code === 'ai_not_configured' && err.message === 'Qwen is not configured: DASHSCOPE_API_KEY is missing.');
  await assert.rejects(() => tutor.message('硬膜外', voice), (err) => err.code === 'ai_not_configured');
});

test('the decision schema carries structured lesson state', () => {
  for (const key of ['intent', 'understood', 'correct', 'needs_retry', 'exercise_complete', 'next_action', 'student_confidence', 'speech']) {
    assert.ok(DECISION_SCHEMA.required.includes(key), key);
  }
  for (const i of ['answer', 'uncertain', 'hint_request', 'explain_request', 'question', 'pronunciation_question', 'practice_again', 'roleplay_request', 'continue']) {
    assert.ok(INTENTS.includes(i), i);
  }
});

test('session start sends the teacher the entry and lesson state; mic language is Mandarin', async () => {
  const { tutor, teacher } = setup();
  teacher.next(decision({ speech: [{ lang: 'en', text: 'Welcome, Roy.', show: null, slow: false }, { lang: 'zh', text: '硬膜外', show: '硬膜外 — yìng mó wài', slow: true }] }));
  const r = await tutor.start();
  const ctx = last(teacher);
  assert.equal(ctx.event, 'session_start');
  assert.equal(ctx.current_entry.english, 'epidural');
  assert.equal(ctx.current_entry.mandarin, '硬膜外');
  assert.deepEqual(ctx.current_entry.pinyin_syllables_with_tones.map((s) => s.tone), [4, 2, 4]);
  assert.equal(ctx.current_entry.meaning, FIXTURE[0].meaning);
  assert.equal(ctx.lesson_state.exercise, 'pronounce');
  assert.equal(ctx.lesson_state.microphone_language_now, 'Mandarin (zh-CN)');
  assert.equal(r.listen, 'zh-CN');
  assert.equal(r.mode, 'pronunciation');
  assert.deepEqual(r.say[1], { lang: 'zh', text: '硬膜外', show: '硬膜外 — yìng mó wài', rate: 0.6 });
  assert.equal(r.status.total, 3);
});

test('Roy\'s turn: transcript, recogniser details and the ASR evaluation go to the teacher; no pronunciation score is claimed', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  await tutor.message('应膜外', { source: 'voice', alternatives: ['英模外'], confidence: 0.7, language: 'zh-CN' });
  const said = last(teacher).roy_said;
  assert.equal(said.text, '应膜外');
  assert.match(said.input, /voice/);
  assert.equal(said.recogniser_language, 'zh-CN');
  assert.deepEqual(said.recogniser_alternatives, ['英模外']);
  const ev = said.asr_evaluation;
  assert.equal(ev.level, 'likely_correct_asr_character_mismatch', '应 is also yìng');
  assert.equal(ev.expected, '硬膜外');
  assert.deepEqual(ev.characters.map((c) => c.comparison), ['same_sound', 'same_character', 'same_character']);
  assert.match(ev.what_this_is, /not ground truth/);
  assert.match(ev.what_this_is, /not a tone score/);
  assert.equal(said.pronunciation_assessment, null);
});

test('typed input is marked as a text fallback with no ASR evaluation', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  await tutor.message('硬膜外', { source: 'text' });
  const said = last(teacher).roy_said;
  assert.match(said.input, /typed/);
  assert.equal(said.asr_evaluation, null, 'typed characters are what he typed, not a recogniser guess');
});

test('a completed exercise advances; the meaning exercise switches the mic to English', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  assert.equal(last(teacher).if_complete.then, 'exercise "meaning"');
  teacher.next(done());
  const r = await tutor.message('硬膜外', voice);
  assert.equal(r.exercise, 'meaning');
  assert.equal(r.listen, 'en-US');
  assert.equal(r.mode, 'answer');
  assert.equal(r.card.english, null, 'English hidden while Roy explains the meaning');
});

test('"I don\'t know", questions and "let\'s continue" do not complete or fail an exercise', async () => {
  const { db, tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ intent: 'uncertain' }), decision({ intent: 'pronunciation_question' }), decision({ intent: 'continue', exercise_complete: true }));
  await tutor.message("I don't know", voice);
  await tutor.message('Did I pronounce it correctly?', voice);
  const r = await tutor.message("Let's continue", voice);
  assert.equal(r.exercise, 'pronounce', 'still on pronunciation');
  assert.equal(r.listen, 'zh-CN');
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, 'vol1', 1).id).completed, 0);
  assert.equal(last(teacher).conversation_so_far.length, 5, 'history of this session is passed along');
});

test('a wrong answer keeps the exercise open', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ correct: false, needs_retry: true, next_action: 'retry' }));
  const r = await tutor.message('不知道', voice);
  assert.equal(r.exercise, 'pronounce');
  assert.equal(last(teacher).lesson_state.wrong_attempts_this_exercise, 0, 'context was built before the attempt');
  await tutor.message('硬膜', voice);
  assert.equal(last(teacher).lesson_state.wrong_attempts_this_exercise, 1);
});

test('all four exercises complete the word; progress saves and the next entry follows in order', async () => {
  const { db, tutor, teacher } = setup();
  await tutor.start();
  teacher.next(done(), done(), done());
  await tutor.message('硬膜外', voice);
  await tutor.message('an injection into the spine to reduce pain', { source: 'voice' });
  await tutor.message('医生给病人打硬膜外。', voice);
  teacher.next(done());
  const r = await tutor.message('硬膜外', voice);
  const preview = last(teacher);
  assert.equal(preview.lesson_state.exercise, 'roleplay');
  assert.equal(preview.if_complete.next_entry.english, 'test term two', 'the teacher is told which entry comes next');
  assert.equal(r.card.position, 2);
  assert.equal(r.exercise, 'pronounce');
  assert.equal(r.stage, 'new');
  const course = activeCourse(db);
  assert.equal(getProgress(db, 'roy', course.id).current_position, 2);
  const ep = getEntryProgress(db, 'roy', entryAt(db, 'vol1', 1).id);
  assert.equal(ep.completed, 1);
  assert.equal(ep.weak, 0);
  assert.equal(r.status.position, 2);
});

test('role-play on request, then the remaining exercises', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ intent: 'roleplay_request', next_action: 'switch_to_roleplay', roleplay_role: 'Nurse' }));
  const r = await tutor.message('Can we role-play this? I will be the nurse.', { source: 'voice' });
  assert.equal(r.exercise, 'roleplay');
  assert.equal(r.stage, 'conversation');
  assert.equal(r.role, 'Nurse');
  teacher.next(done());
  const after = await tutor.message('病人需要硬膜外', voice);
  assert.equal(after.exercise, 'pronounce', 'goes back to the first exercise not yet passed');
});

test('a jump keeps the saved position; "let\'s continue" comes back', async () => {
  const { db, tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ intent: 'jump_request', jump_target: 'test term three', next_action: 'jump' }));
  const j = await tutor.message('teach me test term three', { source: 'voice' });
  assert.equal(last(teacher).event, 'jump_started');
  assert.equal(last(teacher).current_entry.position, 3);
  assert.equal(j.card.position, 3);
  assert.equal(j.jump, true);
  assert.equal(getProgress(db, 'roy', activeCourse(db).id).current_position, 1);
  teacher.next(decision({ intent: 'continue', next_action: 'resume' }));
  const back = await tutor.message("Let's continue", { source: 'voice' });
  assert.equal(last(teacher).event, 'returned_from_jump');
  assert.equal(back.card.position, 1);
});

test('a jump to a word outside the curriculum is refused', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(decision({ intent: 'jump_request', jump_target: 'appendectomy', next_action: 'jump' }));
  const r = await tutor.message('teach me appendectomy', { source: 'voice' });
  assert.equal(last(teacher).event, 'jump_not_found');
  assert.equal(r.card.position, 1);
});

test('"stop" ends the session with the teacher\'s goodbye and a saved summary', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  teacher.next(decision({ intent: 'stop', next_action: 'end_session', speech: [{ lang: 'en', text: 'Great work, Roy!', show: null, slow: false }] }));
  const r = await tutor.message("That's all for today", { source: 'voice' });
  assert.equal(r.ended, true);
  assert.equal(r.say[0].text, 'Great work, Roy!');
  assert.match(r.say.at(-1).text, /New words: epidural/);
});

test('a new day starts with review of yesterday, then new material', async () => {
  const { db, tutor, teacher, setClock } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  await tutor.end();

  setClock('2026-09-28T09:00:00');
  const r = await tutor.start();
  const ctx = last(teacher);
  assert.equal(ctx.event, 'session_start');
  assert.match(ctx.event_details, /Welcome back, Roy\. Yesterday we studied epidural\./);
  assert.equal(ctx.lesson_state.exercise, 'review');
  assert.equal(ctx.current_entry.english, 'epidural');
  assert.equal(r.stage, 'review');
  assert.equal(r.card.mandarin, null, 'answer hidden during review');

  teacher.next(decision({ correct: false, exercise_complete: true }));
  const miss = await tutor.message('不知道', voice);
  assert.equal(miss.stage, 'review', 'a missed word comes round once more');
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, 'vol1', 1).id).weak, 1);
  teacher.next(done());
  const next = await tutor.message('硬膜外', voice);
  assert.equal(next.stage, 'new');
  assert.equal(next.card.position, 2);
  assert.equal(getProgress(db, 'roy', activeCourse(db).id).review_required, 0);
});

test('same-day return resumes the open session', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  teacher.next(done());
  await tutor.message('硬膜外', voice);
  const r = await tutor.start();
  assert.equal(last(teacher).event, 'session_resume');
  assert.equal(r.exercise, 'meaning');
  assert.equal(r.listen, 'en-US');
});

test('an open session saved by the old scripted engine is replaced, keeping progress', async () => {
  const { db, tutor, teacher } = setup();
  const course = activeCourse(db);
  const old = (await import('../src/db.js')).createSession(db, 'roy', course.id, '2026-09-27', '2026-09-27T08:00:00Z');
  db.prepare("UPDATE study_sessions SET state = ? WHERE id = ?").run(JSON.stringify({ stage: 'new', lesson: { entryId: 2, step: 'recognize' } }), old.id);
  getProgress(db, 'roy', course.id);
  db.prepare('UPDATE user_progress SET current_position = 2, last_session = ?, last_study_date = ? WHERE user_id = ?').run(old.id, '2026-09-27', 'roy');
  const r = await tutor.start();
  assert.equal(last(teacher).event, 'session_start');
  assert.equal(r.card.position, 2);
  assert.equal(r.exercise, 'pronounce');
});

test('Qwen is the only provider: DASHSCOPE_API_KEY, QWEN_MODEL and QWEN_BASE_URL from the environment', () => {
  const defaults = qwenSettings({});
  assert.equal(defaults.label, 'Qwen');
  assert.equal(defaults.keyName, 'DASHSCOPE_API_KEY');
  assert.equal(defaults.apiKey, '');
  assert.equal(defaults.model, 'qwen3.8-flash');
  assert.equal(QWEN_DEFAULT_MODEL, 'qwen3.8-flash');
  assert.equal(defaults.baseURL, 'https://ws-c2mgxehx4ud1bn7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(QWEN_DEFAULT_BASE_URL, defaults.baseURL);
  assert.equal(defaults.enableThinking, false);
  const custom = qwenSettings({ DASHSCOPE_API_KEY: 'k', QWEN_MODEL: 'qwen-plus', QWEN_BASE_URL: 'https://example.test/compatible-mode/v1' });
  assert.equal(custom.apiKey, 'k');
  assert.equal(custom.model, 'qwen-plus');
  assert.equal(custom.baseURL, 'https://example.test/compatible-mode/v1');
  assert.equal(qwenSettings({ OPENAI_API_KEY: 'k' }).apiKey, '', 'an OpenAI key is not used');
  const t = createTeacher({ env: {} });
  assert.equal(t.configured, false);
  assert.equal(t.provider, 'qwen');
  assert.equal(t.model, 'qwen3.8-flash');
});

test('Qwen request: JSON mode, schema in the prompt, max_tokens, thinking off; a reply that misses the schema is retried once', async () => {
  const calls = [];
  const replies = [JSON.stringify({ intent: 'answer' }), JSON.stringify(decision({ intent: 'uncertain' }))];
  const client = { chat: { completions: { create: async (params) => {
    calls.push(params);
    return { id: `q${calls.length}`, model: params.model, choices: [{ finish_reason: 'stop', message: { content: replies.shift() } }] };
  } } } };
  const teacher = createTeacher({ client, log: { log() {}, warn() {} }, env: {} });
  const out = await teacher.decide({ event: 'student_turn', current_entry: { english: 'epidural' }, roy_said: { text: "I don't know this word." } });
  assert.equal(out.intent, 'uncertain');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].model, 'qwen3.8-flash');
  assert.deepEqual(calls[0].response_format, { type: 'json_object' });
  assert.equal(calls[0].max_tokens, 4000);
  assert.equal(calls[0].enable_thinking, false);
  assert.equal(calls[0].reasoning_effort, undefined);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.match(calls[0].messages[0].content, /JH Medics Volume 1/);
  assert.match(calls[0].messages[0].content, /OUTPUT FORMAT[\s\S]*"exercise_complete"/);
  assert.match(calls[0].messages[1].content, /I don't know this word/);
  assert.match(calls[0].messages[1].content, /epidural/);
  assert.match(calls[1].messages.at(-1).content, /did not match the required JSON schema/);
});

test('Qwen: a reply that still misses the schema is an error, not a scripted answer', async () => {
  const client = { chat: { completions: { create: async () => ({ id: 'x', model: 'qwen3.8-flash', choices: [{ finish_reason: 'stop', message: { content: '{"intent":"answer"}' } }] }) } } };
  const teacher = createTeacher({ client, log: { log() {}, warn() {} }, env: {} });
  await assert.rejects(() => teacher.decide({ event: 'student_turn' }), /did not match the lesson schema/);
  assert.deepEqual(checkDecision(decision()), []);
  assert.ok(checkDecision({ ...decision(), intent: 'dance' }).some((p) => /intent must be one of/.test(p)));
});

// ---------- invalid next_action and other form problems from Qwen ----------

function qwenReturning(...replies) {
  const calls = [];
  const client = { chat: { completions: { create: async (params) => {
    calls.push(params);
    const r = replies.shift();
    return { id: `q${calls.length}`, model: params.model, choices: [{ finish_reason: 'stop', message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
  } } } };
  const warnings = [];
  const teacher = createTeacher({ client, log: { log() {}, warn: (m) => warnings.push(m) }, env: {} });
  return { teacher, calls, warnings };
}

test('invalid next_action: mapped to an allowed value without a retry, and the repair is logged', async () => {
  const { teacher, calls, warnings } = qwenReturning(decision({ correct: true, exercise_complete: true, next_action: 'Move On' }));
  const out = await teacher.decide({ event: 'student_turn' });
  assert.equal(out.next_action, 'next_exercise');
  assert.equal(calls.length, 1, 'no second request needed');
  assert.ok(warnings.some((w) => /next_action: "Move On" -> "next_exercise"/.test(w)));
  assert.deepEqual(checkDecision(out), [], 'the repaired reply passes the schema check');
});

test('invalid next_action that cannot be mapped is derived safely and never ends, jumps or resumes', () => {
  const base = decision();
  for (const [bad, complete, retry, expected] of [
    ['go_to_meaning_exercise', true, false, 'next_exercise'],
    ['ask_differently', false, true, 'retry'],
    ['explain_more', false, false, 'same_exercise'],
    ['end', false, false, 'same_exercise'],
    ['jump_to', false, false, 'same_exercise'],
    ['return', false, false, 'same_exercise'],
    [42, false, false, 'same_exercise'],
    [undefined, false, false, 'same_exercise'],
  ]) {
    const { decision: d } = normalizeDecision({ ...base, next_action: bad, exercise_complete: complete, needs_retry: retry });
    assert.equal(d.next_action, expected, String(bad));
    assert.ok(!['end_session', 'jump', 'resume'].includes(d.next_action));
  }
  // Exact values (and plain spelling variants of them) are kept.
  assert.equal(normalizeDecision({ ...base, next_action: 'end_session' }).decision.next_action, 'end_session');
  assert.equal(normalizeDecision({ ...base, next_action: 'Switch To Roleplay' }).decision.next_action, 'switch_to_roleplay');
  // An unknown intent becomes "unclear", which cannot complete an exercise.
  assert.equal(normalizeDecision({ ...base, intent: 'completed_the_task' }).decision.intent, 'unclear');
  assert.equal(normalizeDecision({ ...base, intent: 'end' }).decision.intent, 'unclear');
});

test('other form slips are repaired: string booleans, casing, speech as plain text, missing show/slow', () => {
  const { decision: d, repairs } = normalizeDecision({
    intent: 'Hint Request', understood: 'true', correct: 'null', needs_retry: 'false', exercise_complete: 'false',
    next_action: 'Same Exercise', student_confidence: 'LOW', jump_target: '', roleplay_role: 'nurse',
    speech: [{ lang: 'Mandarin', text: '硬膜外' }, 'Try saying it again.'], notes: null,
  });
  assert.deepEqual(checkDecision(d), []);
  assert.equal(d.intent, 'hint_request');
  assert.equal(d.understood, true);
  assert.equal(d.correct, null);
  assert.equal(d.exercise_complete, false);
  assert.equal(d.student_confidence, 'struggling');
  assert.equal(d.roleplay_role, 'Nurse');
  assert.deepEqual(d.speech, [{ lang: 'zh', text: '硬膜外', show: null, slow: false }, { text: 'Try saying it again.', lang: 'en', show: null, slow: false }]);
  assert.ok(repairs.length >= 8);
});

test('the prompt spells out the allowed next_action values with an example reply', async () => {
  const { teacher, calls } = qwenReturning(decision());
  await teacher.decide({ event: 'student_turn' });
  const system = calls[0].messages[0].content;
  for (const v of ['retry', 'same_exercise', 'next_exercise', 'switch_to_roleplay', 'jump', 'resume', 'end_session']) assert.match(system, new RegExp(`"${v}"`));
  assert.match(system, /Do not invent other values/);
  assert.match(system, /Example of a complete reply/);
  const example = JSON.parse(system.slice(system.indexOf('{"intent"'), system.indexOf('\n', system.indexOf('{"intent"'))));
  assert.deepEqual(checkDecision(example), [], 'the example in the prompt is itself valid');
});

test('a lesson turn with an invalid next_action does not crash and keeps the curriculum rules', async () => {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  importEntries(db, 'vol1', FIXTURE);
  const { teacher } = qwenReturning(
    decision({ intent: 'other' }),
    // "I don't know" with a made-up next_action and a premature completion:
    decision({ intent: 'uncertain', exercise_complete: true, next_action: 'show_the_answer' }),
    // a correct answer with a made-up next_action:
    decision({ intent: 'answer', correct: true, exercise_complete: true, next_action: 'proceed_to_meaning' }),
  );
  const tutor = new Tutor({ db, teacher, now: () => new Date('2026-09-28T10:00:00') });
  await tutor.start();
  const unsure = await tutor.message("I don't know this word.", { source: 'text' });
  assert.equal(unsure.exercise, 'pronounce', 'not an answer, so the exercise is not completed');
  assert.equal(unsure.ended, undefined);
  const right = await tutor.message('硬膜外', { source: 'voice' });
  assert.equal(right.exercise, 'meaning', 'a real answer still advances in order');
  assert.equal(right.listen, 'en-US');
  assert.equal(getProgress(db, 'roy', activeCourse(db).id).current_position, 1);
});

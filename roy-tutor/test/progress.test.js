// One curriculum position shared by Interactive Practice and Listen & Learn:
// sequential progress, completion only when a lesson really finished,
// review of the previous study day (including words learnt by listening),
// and the real server's Listen routes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDb, getProgress, getEntryProgress, activeCourse, entryAt } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';
import { encodeWav } from '../public/voice-core.js';
import { freePort, cleanEnv } from './helpers.js';

const FIXTURE = [
  { position: 1, english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: "Injection into a person's spine", source_page: '1' },
  { position: 2, english: 'esophagus', mandarin: '食道', pinyin: 'shí dào', meaning: 'The tube to the stomach', source_page: '1' },
  { position: 3, english: 'test term three', mandarin: '测试三', pinyin: 'cè shì sān', meaning: 'placeholder three', source_page: '1' },
  { position: 4, english: 'test term four', mandarin: '测试四', pinyin: 'cè shì sì', meaning: 'placeholder four', source_page: '1' },
];

function decision(over = {}) {
  return {
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'Teacher reply.', show: null, slow: false }], notes: '', ...over,
  };
}
const done = () => decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' });

function setup() {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  importEntries(db, 'vol1', FIXTURE);
  let clock = new Date('2026-09-28T10:00:00');
  const queue = [];
  const contexts = [];
  const teacher = { configured: true, contexts, next: (...d) => queue.push(...d), async decide(ctx) { contexts.push(ctx); return queue.shift() ?? decision(); } };
  const tutor = new Tutor({ db, teacher, now: () => clock });
  const pos = () => getProgress(db, 'roy', activeCourse(db).id).current_position;
  const completed = (p) => getEntryProgress(db, 'roy', entryAt(db, 'vol1', p).id).completed;
  return { db, tutor, teacher, pos, completed, setClock: (d) => { clock = new Date(d); } };
}
const voice = { source: 'voice', language: 'zh-CN' };

async function passWord(tutor, teacher, entry) {
  teacher.next(done(), done(), done(), done());
  await tutor.message(entry.mandarin, voice);
  await tutor.message(entry.english, { source: 'voice', language: 'en-US' });
  await tutor.message(`医生说${entry.mandarin}。`, voice);
  return tutor.message(entry.mandarin, voice);
}

// ---------- the engine ----------

test('finishing the current word\'s Listen lesson completes it and moves the shared position N → N+1', () => {
  const { tutor, pos, completed } = setup();
  assert.equal(pos(), 1);
  const r = tutor.completeByListening(1);
  assert.equal(r.completed, true);
  assert.equal(r.currentPosition, 2);
  assert.equal(pos(), 2);
  assert.equal(completed(1), 1);
  assert.equal(tutor.status().position, 2, 'Interactive Practice sees the same position');
  assert.equal(tutor.status().completed, 1);
  assert.equal(tutor.completeByListening(2).currentPosition, 3, 'and on to word 3');
});

test('one shared place: a word heard ahead (after Next) is completed but never moves the place past a skipped word; the place then passes completed words', () => {
  const { tutor, pos, completed } = setup();
  const ahead = tutor.completeByListening(3); // Roy pressed Next on 1 and 2, then heard 3 in full
  assert.equal(ahead.completed, true, 'word 3 was heard in full: completed');
  assert.equal(ahead.placeMoved, false);
  assert.equal(pos(), 1, 'the place stays at the skipped word 1');
  assert.equal(completed(3), 1);
  assert.equal(completed(1), 0, 'the skipped word is not completed');
  tutor.completeByListening(1);
  assert.equal(pos(), 2, 'word 2 was skipped too: the place stops there');
  tutor.completeByListening(2);
  assert.equal(pos(), 4, 'word 3 is already completed: the place passes it');
  assert.equal(tutor.completeByListening(1).completed, false, 'listening to an earlier word again changes nothing');
  assert.equal(pos(), 4);
  assert.equal(tutor.completeByListening(2, { review: true }).completed, false, 'a review lesson never completes a word');
  assert.equal(pos(), 4);
  assert.equal(tutor.listenProgress().listened, 3, 'words 1, 2 and 3 were fully listened to');
  assert.throws(() => tutor.completeByListening(99), /not in the curriculum/);
});

test('the last word: listening completes the course', () => {
  const { tutor } = setup();
  for (const e of FIXTURE) tutor.completeByListening(e.position);
  assert.equal(tutor.listenProgress().finished, true);
  assert.equal(tutor.status().finished, true);
  assert.equal(tutor.listenPlan().position, null);
});

test('Interactive Practice on the same word moves on when Listen & Learn completes it', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  assert.equal(tutor.status().session.card.position, 1);
  tutor.completeByListening(1);
  assert.equal(tutor.status().session.card.position, 2, "today's session now teaches word 2");
  assert.equal(tutor.status().session.exercise, 'pronounce');
  await tutor.start(); // back to Interactive Practice: resumes today's session
  const ctx = teacher.contexts.at(-1);
  assert.equal(ctx.event, 'session_resume');
  assert.match(ctx.event_details, /introduce the entry first/);
  assert.equal(ctx.current_entry.mandarin, '食道');
  // Completing word 2 interactively moves to word 3, in order.
  const r = await passWord(tutor, teacher, FIXTURE[1]);
  assert.equal(r.status.position, 3);
});

test('Interactive progress is shared with Listen & Learn: what Interactive completes, Listen continues after', async () => {
  const { tutor, teacher } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  const plan = tutor.listenPlan();
  assert.equal(plan.position, 2);
  assert.deepEqual(plan.review, [], 'same study day: no review');
});

test('a new study day: Interactive review includes the words learnt by listening the day before', async () => {
  const { tutor, teacher, setClock } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]); // word 1 interactively
  await tutor.end();
  tutor.completeByListening(2); // word 2 by listening, same day
  setClock('2026-09-29T09:00:00');
  await tutor.start();
  const ctx = teacher.contexts.at(-1);
  assert.equal(ctx.lesson_state.exercise, 'review');
  assert.match(ctx.event_details, /Yesterday we studied epidural and esophagus/);
  assert.equal(tutor.status().reviewRequired, true);
});

test('listening first on a new day does not skip the day\'s Interactive review', async () => {
  const { tutor, teacher, setClock } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  await tutor.end();
  setClock('2026-09-29T08:00:00');
  tutor.completeByListening(2); // listen first thing
  setClock('2026-09-29T09:00:00');
  await tutor.start();
  assert.equal(teacher.contexts.at(-1).lesson_state.exercise, 'review', 'review of yesterday still comes first');
  assert.equal(tutor.status().session.card.position, 1, 'reviewing word 1');
});

test('a listening-only day is reviewed on the next day too', async () => {
  const { tutor, teacher, setClock } = setup();
  tutor.completeByListening(1);
  tutor.completeByListening(2);
  setClock('2026-09-29T09:00:00');
  await tutor.start();
  const ctx = teacher.contexts.at(-1);
  assert.equal(ctx.lesson_state.exercise, 'review');
  assert.match(ctx.event_details, /Yesterday we studied epidural and esophagus/);
});

test('Listen & Learn review: on a new day it plays the previous day\'s words first, once', async () => {
  const { tutor, teacher, setClock } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  await tutor.end();
  tutor.completeByListening(2);
  assert.deepEqual(tutor.listenPlan().review, [], 'no review on the same day');
  setClock('2026-09-29T09:00:00');
  const plan = tutor.listenPlan();
  assert.deepEqual(plan.review, [1, 2]);
  assert.equal(plan.position, 3, 'then the current word');
  tutor.completeByListening(1, { review: true });
  tutor.completeByListening(2, { review: true });
  tutor.listenReviewDone();
  assert.deepEqual(tutor.listenPlan().review, [], 'only once per day');
  assert.equal(tutor.listenPlan().position, 3, 'review lessons did not move the place');
});

test('Listen review is skipped once today\'s Interactive session exists (it reviews there)', async () => {
  const { tutor, teacher, setClock } = setup();
  await tutor.start();
  await passWord(tutor, teacher, FIXTURE[0]);
  await tutor.end();
  setClock('2026-09-29T09:00:00');
  await tutor.start();
  assert.deepEqual(tutor.listenPlan().review, []);
});

test('natural answers through the engine: "I don\'t know", "I don\'t understand", repeat and continue never complete or fail', async () => {
  const { tutor, teacher, pos } = setup();
  await tutor.start();
  const turns = [
    ['I don\'t know', 'uncertain'],
    ['I don\'t understand', 'question'],
    ['Can you repeat that?', 'repeat_request'],
    ['Let\'s continue', 'continue'],
    ['嗯，好的', 'off_topic'],
  ];
  for (const [text, intent] of turns) {
    teacher.next(decision({ intent, correct: null, exercise_complete: intent === 'continue' }));
    const r = await tutor.message(text, voice);
    assert.equal(r.exercise, 'pronounce', `${text}: still on the same exercise`);
  }
  assert.equal(teacher.contexts.at(-1).lesson_state.wrong_attempts_this_exercise, 0, 'none counted as wrong');
  assert.equal(pos(), 1);
});

// ---------- the real server ----------

const KEY = 'test-key-not-real-progress-5555';
const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Stand-in for Qwen: the listen writer (chat; `writer` decides the reply) and TTS.
async function fakeQwen(writer) {
  const wav = Buffer.from(encodeWav(new Float32Array(2400).fill(0.1), 24000));
  const seen = { writer: [], teacherTurns: 0, tts: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (b, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/tts') { seen.tts += 1; return json({ output: { audio: { data: wav.toString('base64') } } }); }
    if (req.url === '/teacher/chat/completions') {
      const body = JSON.parse(raw);
      if (/You write the teaching layer/.test(body.messages[0].content)) {
        const entry = JSON.parse(body.messages[1].content);
        seen.writer.push(entry.mandarin);
        return json({ id: 'w', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: writer(entry) } }] });
      }
      seen.teacherTurns += 1;
    }
    json({}, 500);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

async function startServer(qwenPort, extra = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-progress-'));
  const base = `http://127.0.0.1:${qwenPort}`;
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: KEY, QWEN_BASE_URL: `${base}/teacher`, QWEN_ASR_BASE_URL: `${base}/asr`, QWEN_TTS_URL: `${base}/tts`, ...extra };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('tutor on')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const url = `http://localhost:${port}`;
  const received = [];
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    received.push(text);
    return { status: r.status, body: JSON.parse(text) };
  };
  const stop = () => { const exited = new Promise((r) => child.once('exit', r)); child.kill(); return exited; };
  return { url, call, received, stop };
}

const goodWriter = (e) => JSON.stringify({ explanation_en: `In medical communication this term means ${e.english}.`, dialogue: [], sentence_zh: `医生说${e.mandarin}需要检查。`, sentence_en: `The doctor said the ${e.english} needs to be checked.`, usage_en: `Doctors use this word when examining the ${e.english}.`, context_en: `A doctor tells a patient, through the interpreter, that the ${e.english} needs to be checked.` });

test('server: Listen follows the shared position; only a finished lesson completes a word; Interactive sees it', async () => {
  const q = await fakeQwen(goodWriter);
  const s = await startServer(q.port);
  try {
    const one = (await s.call('GET', '/api/listen')).body;
    assert.equal(one.position, 1, "starts at Roy's current word");
    assert.equal(one.review, false);
    assert.deepEqual(one.next, { position: 2, review: false }, 'says what follows');
    assert.ok(one.steps.find((st) => st.kind === 'sentence').text.includes('硬膜外'));
    assert.ok(one.steps.every((st) => /^[a-z0-9]+$/.test(st.audio)), 'Qwen audio for every step');

    // Fetching lessons (even ahead) changes nothing.
    await s.call('GET', '/api/listen?position=2');
    await s.call('GET', '/api/listen?position=1');
    let st = (await s.call('GET', '/api/status')).body;
    assert.equal(st.position, 1, 'fetching or starting audio is not finishing a lesson');
    assert.equal(st.completed, 0);
    assert.deepEqual(q.seen.writer, ['硬膜外', '食道'], 'each example written once');

    const done1 = (await s.call('POST', '/api/listen/complete', { position: 1 })).body;
    assert.deepEqual([done1.completed, done1.currentPosition, done1.completedWords], [true, 2, 1]);
    st = (await s.call('GET', '/api/status')).body;
    assert.equal(st.position, 2, 'Interactive Practice is at word 2 too');
    assert.equal((await s.call('GET', '/api/listen')).body.position, 2);

    const ahead = (await s.call('POST', '/api/listen/complete', { position: 4 })).body;
    assert.deepEqual([ahead.completed, ahead.placeMoved, ahead.currentPosition], [true, false, 2], 'a word heard ahead is completed, but the place stays at the skipped word');
    // The lesson carries the structured teaching layer written by Qwen.
    assert.equal(one.teaching.source, 'teacher');
    assert.match(one.teaching.explanation_en, /epidural/);
    assert.ok(one.teaching.usage_en && one.teaching.sentence_en && one.teaching.context_en);
    assert.equal((await s.call('POST', '/api/listen/complete', { position: 999 })).status, 400);
    assert.equal((await s.call('POST', '/api/listen/complete', {})).status, 400);
    assert.equal((await s.call('GET', '/api/listen?position=0')).status, 400);
    assert.equal(q.seen.teacherTurns, 0, 'no Interactive teacher turn');
    for (const text of s.received) assert.ok(!text.includes(KEY) && !/DASHSCOPE_API_KEY=|Authorization|Bearer/.test(text), 'the key never reaches the browser');
  } finally {
    await s.stop();
    await q.close();
  }
});

test('server: a malformed Qwen example is rejected and the lesson still plays with a safe fallback (not stored)', async () => {
  const q = await fakeQwen(() => '{"sentence_zh": "今天天气很好。", "sentence_en": "Nice weather."}'); // wrong word, fields missing
  const s = await startServer(q.port);
  try {
    const one = (await s.call('GET', '/api/listen')).body;
    const sentence = one.steps.find((st) => st.kind === 'sentence');
    assert.equal(sentence.source, 'template');
    assert.ok(sentence.text.includes('硬膜外'), 'the fallback still uses the exact word');
    assert.equal(q.seen.writer.length, 2, 'one correction round, then fallback');
    await s.call('GET', '/api/listen?position=1');
    assert.equal(q.seen.writer.length, 4, 'a fallback is not stored: Qwen is asked again next time');
  } finally {
    await s.stop();
    await q.close();
  }
});

test('server: TUTOR_ACCESS_CODE protects the Listen routes too', async () => {
  const q = await fakeQwen(goodWriter);
  const s = await startServer(q.port, { TUTOR_ACCESS_CODE: 'letmein' });
  try {
    assert.equal((await s.call('GET', '/api/listen')).status, 401);
    assert.equal((await s.call('POST', '/api/listen/complete', { position: 1 })).status, 401);
    assert.equal(q.seen.writer.length + q.seen.tts, 0, 'nothing was sent to Qwen');
    assert.equal((await s.call('GET', '/api/listen', null, { 'X-Access-Code': 'letmein' })).status, 200);
    assert.equal((await s.call('POST', '/api/listen/complete', { position: 1 }, { 'X-Access-Code': 'letmein' })).status, 200);
  } finally {
    await s.stop();
    await q.close();
  }
});

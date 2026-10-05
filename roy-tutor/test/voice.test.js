import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recognitionLang, otherLanguage, lessonStateText, friendlyError, VOICE_ERRORS } from '../public/voice-core.js';
import { openDb, getProgress, getEntryProgress, entryAt, activeCourse } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';

// ---------- microphone language ----------

test('answer language: zh-CN for Mandarin, en-US for English', () => {
  assert.equal(recognitionLang('zh-CN'), 'zh-CN');
  assert.equal(recognitionLang('en-US'), 'en-US');
  assert.equal(recognitionLang(undefined), 'en-US');
  assert.equal(otherLanguage('zh-CN'), 'en-US');
  assert.equal(otherLanguage('en-US'), 'zh-CN');
});

// ---------- lesson state line ----------

test('lesson state text follows the tutor\'s view of the lesson', () => {
  assert.equal(lessonStateText({ stage: 'new', exercise: 'pronounce', card: { position: 1 } }), 'Item 1 · Say the Mandarin term');
  assert.equal(lessonStateText({ stage: 'new', exercise: 'meaning', card: { position: 1 } }), 'Item 1 · Explain the meaning in English');
  assert.equal(lessonStateText({ stage: 'conversation', exercise: 'roleplay', role: 'Interpreter', card: { position: 2 } }), 'Item 2 · Role-play (you are the interpreter)');
  assert.equal(lessonStateText({ stage: 'review', exercise: 'review', card: { position: 1 } }), 'Item 1 · Review: say the Mandarin');
  assert.equal(lessonStateText({ stage: 'new', exercise: 'pronounce', jump: true, card: { position: 12 } }), 'Item 12 · Say the Mandarin term · side trip, your place is saved');
  assert.equal(lessonStateText({ stage: 'done' }), 'All items complete');
});

// ---------- error messages ----------

test('errors become plain messages', () => {
  assert.match(friendlyError({ code: 'ai_not_configured' }), /not set up on the server/);
  assert.match(friendlyError({ code: 'ai_request_failed', status: 502 }), /Qwen\) didn't answer/);
  assert.match(friendlyError(Object.assign(new TypeError('Failed to fetch'), { code: 'network' })), /Can't reach the tutor server/);
  assert.match(friendlyError({ code: 'server_error', status: 500 }), /server had a problem/);
  for (const key of ['not-allowed', 'no-mic', 'unsupported', 'insecure-context', 'asr_failed', 'asr_empty', 'tts_failed']) assert.ok(VOICE_ERRORS[key], key);
  assert.match(friendlyError({ code: 'asr_failed', status: 502 }), /RETRY/);
  assert.match(friendlyError({ code: 'tts_failed', status: 502 }), /Read it in the conversation/);
});

// ---------- the voice bridge reaches the same engine ----------

const FIXTURE = [
  { position: 1, english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: 'Injection into the spine', source_page: '1' },
  { position: 2, english: 'esophagus', mandarin: '食道', pinyin: 'shí dào', meaning: 'The tube to the stomach', source_page: '1' },
];

function decision(over = {}) {
  return {
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'Say it: 硬膜外', show: null, slow: false }], notes: '', ...over,
  };
}

function setup(teacher) {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  importEntries(db, 'vol1', FIXTURE);
  return { db, tutor: new Tutor({ db, teacher, now: () => new Date('2026-09-28T10:00:00') }) };
}

test('a voice transcript goes through the tutor engine with its recogniser details', async () => {
  const contexts = [];
  const queue = [decision(), decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' })];
  const teacher = { configured: true, async decide(ctx) { contexts.push(ctx); return queue.shift() ?? decision(); } };
  const { tutor } = setup(teacher);
  const start = await tutor.start();
  assert.equal(start.listen, 'zh-CN');
  // What app.js sends for a voice answer, including a mic language Roy switched to.
  const r = await tutor.message('硬膜外', { source: 'voice', alternatives: ['硬模外'], confidence: 0.8, language: 'zh-CN' });
  const said = contexts.at(-1).roy_said;
  assert.equal(said.text, '硬膜外');
  assert.equal(said.recogniser_language, 'zh-CN');
  assert.deepEqual(said.recogniser_alternatives, ['硬模外']);
  assert.equal(r.exercise, 'meaning');
  assert.equal(r.listen, 'en-US', 'the next answer is expected in English');
  assert.ok(r.say.every((s) => typeof s.text === 'string' && ['en', 'zh'].includes(s.lang)));
});

test('a Qwen failure mid-lesson changes nothing, and the next turn works', async () => {
  let fail = false;
  const teacher = {
    configured: true,
    async decide() {
      if (fail) throw Object.assign(new Error('503 upstream unavailable'), { status: 503 });
      return decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' });
    },
  };
  const { db, tutor } = setup(teacher);
  await tutor.start();
  fail = true;
  await assert.rejects(() => tutor.message('硬膜外', { source: 'voice' }), /upstream unavailable/);
  assert.equal(tutor.status().session.exercise, 'pronounce', 'still on the same exercise');
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, 'vol1', 1).id).completed, 0);
  assert.equal(getProgress(db, 'roy', activeCourse(db).id).current_position, 1);
  fail = false;
  const r = await tutor.message('硬膜外', { source: 'voice' });
  assert.equal(r.exercise, 'meaning');
});

// ---------- security ----------

test('no API key or key name is in anything served to the browser', () => {
  const dir = new URL('../public/', import.meta.url);
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(new URL(file, dir), 'utf8');
    assert.doesNotMatch(text, /sk-[A-Za-z0-9]{8,}/, `${file} contains something that looks like a key`);
    assert.doesNotMatch(text, /process\.env|aliyuncs|apiKey|Authorization/i, `${file} refers to server configuration or Qwen directly`);
  }
  const { tutor } = setup({ configured: true, async decide() { return decision(); } });
  assert.doesNotMatch(JSON.stringify(tutor.status()), /apiKey|DASHSCOPE_API_KEY|sk-/);
});

test('the page uses no browser speech recognition or speech synthesis: voice goes through the server', () => {
  for (const file of ['app.js', 'voice-core.js', 'index.html']) {
    const text = fs.readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /webkitSpeechRecognition|window\.SpeechRecognition|speechSynthesis|SpeechSynthesisUtterance/, file);
  }
  const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  assert.match(app, /\/api\/voice\/transcribe/);
  assert.match(app, /\/api\/voice\/speech\//);
  assert.match(app, /getUserMedia/);
  assert.match(app, /MediaRecorder/);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { recognitionLang, isChromeBrowser, otherLanguage, lessonStateText, speechParts, friendlyError, RECOGNITION_ERRORS, VoiceInput, EVENTS, recognitionStatusText } from '../public/voice-core.js';
import { openDb, getProgress, getEntryProgress, entryAt, activeCourse } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';

// ---------- microphone language ----------

test('recognition language: zh-CN for Mandarin, en-US for English, on every browser', () => {
  assert.equal(recognitionLang('zh-CN'), 'zh-CN');
  assert.equal(recognitionLang('en-US'), 'en-US');
  assert.equal(recognitionLang(undefined), 'en-US');
  assert.equal(isChromeBrowser({ userAgent: 'Mozilla/5.0 ... Chrome/141.0 Safari/537.36' }), true);
  assert.equal(isChromeBrowser({ userAgent: 'Mozilla/5.0 ... Chrome/141.0 Safari/537.36 Edg/141.0' }), false);
  assert.equal(otherLanguage('zh-CN'), 'en-US');
  assert.equal(otherLanguage('en-US'), 'zh-CN');
});

// ---------- lesson state line ----------

test('lesson state text follows the tutor\'s view of the lesson', () => {
  assert.equal(lessonStateText({ stage: 'new', exercise: 'pronounce', card: { position: 1 } }), 'Word 1 · Say the Mandarin term');
  assert.equal(lessonStateText({ stage: 'new', exercise: 'meaning', card: { position: 1 } }), 'Word 1 · Explain the meaning in English');
  assert.equal(lessonStateText({ stage: 'conversation', exercise: 'roleplay', role: 'Interpreter', card: { position: 2 } }), 'Word 2 · Role-play (you are the interpreter)');
  assert.equal(lessonStateText({ stage: 'review', exercise: 'review', card: { position: 1 } }), 'Word 1 · Review: say the Mandarin');
  assert.equal(lessonStateText({ stage: 'new', exercise: 'pronounce', jump: true, card: { position: 12 } }), 'Word 12 · Say the Mandarin term · side trip, your place is saved');
  assert.equal(lessonStateText({ stage: 'done' }), 'All words complete');
});

// ---------- speech playback ----------

test('speech playback: Chinese characters go to the Chinese voice, the rest to the English voice', () => {
  assert.deepEqual(speechParts({ lang: 'en', text: 'The word is 硬膜外, yìng mó wài. Now you say it.' }), [
    { lang: 'en', text: 'The word is' },
    { lang: 'zh', text: '硬膜外' },
    { lang: 'en', text: ', yìng mó wài. Now you say it.' },
  ]);
  assert.deepEqual(speechParts({ lang: 'zh', text: '医生说：我们需要打硬膜外。', rate: 0.6 }), [
    { lang: 'zh', text: '医生说：我们需要打硬膜外。', rate: 0.6 },
  ]);
  assert.deepEqual(speechParts({ lang: 'zh', text: '硬膜外 OK?' }), [{ lang: 'zh', text: '硬膜外' }, { lang: 'en', text: 'OK?' }]);
  assert.deepEqual(speechParts({ lang: 'en', text: '...' }), [], 'punctuation alone is not spoken');
  assert.deepEqual(speechParts({ lang: 'en', text: '' }), []);
});

// ---------- error messages ----------

test('errors become plain messages', () => {
  assert.match(friendlyError({ code: 'ai_not_configured' }), /not set up on the server/);
  assert.match(friendlyError({ code: 'ai_request_failed', status: 502 }), /Qwen\) didn't answer/);
  assert.match(friendlyError(Object.assign(new TypeError('Failed to fetch'), { code: 'network' })), /Can't reach the tutor server/);
  assert.match(friendlyError({ code: 'server_error', status: 500 }), /server had a problem/);
  for (const key of ['not-allowed', 'service-not-allowed', 'audio-capture', 'network']) assert.ok(RECOGNITION_ERRORS[key], key);
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
    assert.doesNotMatch(text, /process\.env|dashscope\.aliyuncs|maas\.aliyuncs/i, `${file} refers to server configuration`);
  }
  const { tutor } = setup({ configured: true, async decide() { return decision(); } });
  assert.doesNotMatch(JSON.stringify(tutor.status()), /apiKey|DASHSCOPE_API_KEY|sk-/);
});

// ---------- speech recognition controller ----------

// A stand-in for Chrome's SpeechRecognition: records settings and lets the test
// fire events in Chrome's order.
class FakeRecognition {
  static instances = [];
  constructor() { FakeRecognition.instances.push(this); this.started = 0; this.aborted = 0; }
  start() { this.started += 1; if (FakeRecognition.throwOnStart) throw new Error('InvalidStateError'); }
  abort() { this.aborted += 1; }
  fire(name, e = {}) { this[`on${name}`]?.(e); }
  result(parts, resultIndex = 0) {
    // parts: [{ text, final, alternatives, confidence }]
    const results = parts.map((p) => Object.assign([{ transcript: p.text, confidence: p.confidence ?? 0.9 }, ...(p.alternatives ?? []).map((a) => ({ transcript: a }))], { isFinal: Boolean(p.final) }));
    this.fire('result', { resultIndex, results });
  }
}

function makeTimers() {
  let now = 0; let id = 0; const pending = new Map();
  return {
    setTimer: (fn, ms) => { pending.set(++id, { at: now + ms, fn }); return id; },
    clearTimer: (i) => pending.delete(i),
    advance(ms) {
      now += ms;
      for (const [i, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) if (t.at <= now && pending.delete(i)) t.fn();
    },
    get count() { return pending.size; },
  };
}

function harness(limits) {
  FakeRecognition.instances = [];
  FakeRecognition.throwOnStart = false;
  const timers = makeTimers();
  const logs = [];
  const voice = new VoiceInput(FakeRecognition, { setTimer: timers.setTimer, clearTimer: timers.clearTimer, log: (m) => logs.push(m), limits });
  const out = { statuses: [], final: null, empty: null, error: null };
  const handlers = {
    onStatus: (kind, d) => out.statuses.push(d?.text ? `${kind}:${d.text}` : kind),
    onFinal: (r) => { out.final = r; },
    onEmpty: (r) => { out.empty = r; },
    onError: (c) => { out.error = c; },
  };
  return { voice, timers, logs, out, handlers, rec: () => FakeRecognition.instances.at(-1) };
}

test('recogniser settings: language, one result per turn, interim results on, alternatives', () => {
  const h = harness();
  h.voice.listen('zh-CN', h.handlers);
  const rec = h.rec();
  assert.equal(rec.lang, 'zh-CN');
  assert.equal(rec.continuous, false);
  assert.equal(rec.interimResults, true);
  assert.equal(rec.maxAlternatives, 5);
  assert.equal(rec.started, 1);
  for (const name of EVENTS) assert.equal(typeof rec[`on${name}`], 'function', `on${name} is handled`);
  h.voice.listen('en-US', h.handlers);
  assert.equal(h.rec().lang, 'en-US');
});

test('a normal turn: every event reported, interim then final transcript, delivered once', () => {
  const h = harness();
  h.voice.listen('zh-CN', h.handlers);
  const rec = h.rec();
  for (const e of ['start', 'audiostart', 'soundstart', 'speechstart']) rec.fire(e);
  rec.result([{ text: '硬膜', final: false }]);
  rec.result([{ text: '硬膜外', final: true, alternatives: ['硬模外'], confidence: 0.83 }]);
  for (const e of ['speechend', 'soundend', 'audioend', 'end']) rec.fire(e);
  assert.deepEqual(h.out.statuses, ['starting', 'listening', 'mic-on', 'sound', 'speech', 'interim:硬膜', 'final:硬膜外', 'speech-end', 'ended']);
  assert.deepEqual(h.out.final, { text: '硬膜外', alternatives: ['硬模外'], confidence: 0.83, lang: 'zh-CN' });
  assert.equal(h.out.empty, null);
  assert.equal(h.out.error, null);
  assert.ok(h.logs.includes('[speech] audiostart') && h.logs.includes('[speech] result') && h.logs.includes('[speech] end'));
  assert.equal(h.voice.listening, false);
  assert.equal(h.timers.count, 0, 'no watchdog left running');
});

test('silence: no-speech ends as empty, and nothing is sent', () => {
  const h = harness();
  h.voice.listen('en-US', h.handlers);
  const rec = h.rec();
  rec.fire('start'); rec.fire('audiostart');
  rec.fire('error', { error: 'no-speech' });
  rec.fire('audioend'); rec.fire('end');
  assert.equal(h.out.final, null);
  assert.equal(h.out.error, null);
  assert.equal(h.out.empty, 'no-speech');
});

test('sound but no words: ends as empty "no-result", not as a transcript', () => {
  const h = harness();
  h.voice.listen('zh-CN', h.handlers);
  const rec = h.rec();
  for (const e of ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend', 'soundend', 'audioend', 'end']) rec.fire(e);
  assert.equal(h.out.final, null);
  assert.equal(h.out.empty, 'no-result');
});

test('whitespace-only results are never delivered as a transcript', () => {
  const h = harness();
  h.voice.listen('en-US', h.handlers);
  const rec = h.rec();
  rec.fire('start'); rec.fire('speechstart');
  rec.result([{ text: '   ', final: true }]);
  rec.fire('end');
  assert.equal(h.out.final, null);
  assert.equal(h.out.empty, 'no-result');
});

test('errors are reported with their real code, e.g. not-allowed, network, audio-capture', () => {
  for (const code of ['not-allowed', 'network', 'audio-capture', 'service-not-allowed', 'language-not-supported']) {
    const h = harness();
    h.voice.listen('zh-CN', h.handlers);
    h.rec().fire('error', { error: code });
    h.rec().fire('end');
    assert.equal(h.out.error, code);
    assert.equal(h.out.final, null);
    assert.ok(h.logs.some((l) => l === `[speech] error ${code}`));
  }
});

test('LISTENING never hangs: no start, silent microphone, and no result after speech are all reported', () => {
  let h = harness({ startMs: 5000 });
  h.voice.listen('zh-CN', h.handlers);
  h.timers.advance(5000); // Chrome never fired onstart
  assert.equal(h.out.error, 'start-timeout');
  assert.equal(h.rec().aborted, 1);

  h = harness({ silentMicMs: 7000 });
  h.voice.listen('zh-CN', h.handlers);
  h.rec().fire('start'); h.rec().fire('audiostart');
  h.timers.advance(7000); // mic open, no sound reaching it
  assert.ok(h.out.statuses.includes('no-sound-yet'));
  assert.equal(h.out.error, null, 'a hint, not a failure: Chrome still decides');

  h = harness({ afterSpeechMs: 8000 });
  h.voice.listen('zh-CN', h.handlers);
  for (const e of ['start', 'audiostart', 'soundstart', 'speechstart', 'speechend']) h.rec().fire(e);
  h.timers.advance(8000); // speech ended but Chrome never sent a result or onend
  assert.equal(h.out.error, 'no-result');
  assert.equal(h.voice.listening, false);

  h = harness({ afterSpeechMs: 8000 });
  h.voice.listen('zh-CN', h.handlers);
  for (const e of ['start', 'speechstart']) h.rec().fire(e);
  h.rec().result([{ text: '硬膜外', final: false }]);
  h.rec().fire('speechend');
  h.timers.advance(8000); // only an interim result arrived: it is used rather than lost
  assert.equal(h.out.final.text, '硬膜外');
});

test('start() throwing is reported instead of leaving the page on LISTENING', () => {
  const h = harness();
  FakeRecognition.throwOnStart = true;
  h.voice.listen('zh-CN', h.handlers);
  assert.equal(h.out.error, 'start-failed');
  assert.equal(h.voice.listening, false);
});

test('switching language or stopping: the old recogniser is aborted and its late events are ignored', () => {
  const h = harness();
  h.voice.listen('zh-CN', h.handlers);
  const old = h.rec();
  old.fire('start');
  h.voice.listen('en-US', h.handlers); // Roy switched the mic language
  assert.equal(old.aborted, 1);
  assert.equal(FakeRecognition.instances.length, 2, 'exactly one new recogniser');
  old.result([{ text: 'stale', final: true }]);
  old.fire('end');
  assert.equal(h.out.final, null, 'nothing from the old recogniser reaches the page');
  const current = h.rec();
  current.fire('start');
  current.result([{ text: "I don't know", final: true }]);
  current.fire('end');
  assert.equal(h.out.final.text, "I don't know");
  assert.equal(h.out.final.lang, 'en-US');

  h.voice.listen('zh-CN', h.handlers);
  h.voice.stop();
  const stopped = h.rec();
  stopped.result([{ text: '硬膜外', final: true }]);
  stopped.fire('end');
  assert.equal(h.out.final.text, "I don't know", 'a stopped turn reports nothing');
});

test('no recognition in the browser is reported, not thrown', () => {
  const out = {};
  const voice = new VoiceInput(undefined);
  assert.equal(voice.available, false);
  voice.listen('zh-CN', { onError: (c) => { out.error = c; } });
  assert.equal(out.error, 'unavailable');
});

test('status text for each recognition stage', () => {
  assert.match(recognitionStatusText('listening', {}, { language: 'Mandarin (zh-CN)' }), /Listening in Mandarin \(zh-CN\)\. Speak now/);
  assert.match(recognitionStatusText('no-sound-yet'), /no sound is reaching it/);
  assert.match(recognitionStatusText('speech'), /Hearing speech/);
  assert.ok(RECOGNITION_ERRORS['no-result'] && RECOGNITION_ERRORS['start-timeout'] && RECOGNITION_ERRORS.timeout && RECOGNITION_ERRORS['start-failed']);
});

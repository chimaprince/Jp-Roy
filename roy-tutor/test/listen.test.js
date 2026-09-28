// Listen & Learn: lesson generation from the curriculum, the player's
// play/pause/repeat/next states, no microphone, and no progress change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenLesson } from '../src/listen.js';
import { ListenController, encodeWav } from '../public/voice-core.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /\p{Script=Han}/u;
const curriculum = JSON.parse(fs.readFileSync(path.join(appDir, 'data', 'jh-medics-vol1.json'), 'utf8'));
const ENTRIES = curriculum.entries ?? curriculum;
const EPIDURAL = ENTRIES[0];

// ---------- lesson generation ----------

test('Listen & Learn lesson for word 1: term, pinyin on screen, English, JH Medics meaning, syllables, term again', () => {
  const l = listenLesson(EPIDURAL, 385);
  assert.equal(l.position, 1);
  assert.equal(l.total, 385);
  assert.deepEqual(l.steps.map((s) => s.kind), ['intro', 'term', 'pinyin', 'english', 'meaning', 'breakdown-intro', 'breakdown', 'repeat', 'end']);
  const by = Object.fromEntries(l.steps.map((s) => [s.kind, s]));
  assert.deepEqual([by.term.lang, by.term.text], ['zh', '硬膜外']);
  // Pinyin is shown, never sent to the voice: the voice says the characters.
  assert.equal(by.pinyin.text, '硬膜外');
  assert.match(by.pinyin.show, /yìng mó wài/);
  assert.ok(by.pinyin.rate < 1, 'said a little slower');
  assert.deepEqual([by.english.lang, by.english.text], ['en', 'In English: epidural.']);
  assert.equal(by.meaning.lang, 'en');
  assert.ok(by.meaning.text.includes(EPIDURAL.meaning), 'the curriculum meaning, verbatim');
  assert.equal(by.breakdown.text, '硬，膜，外');
  assert.equal(by.breakdown.show, '硬 yìng · 膜 mó · 外 wài');
  assert.deepEqual([by.repeat.lang, by.repeat.text], ['zh', '硬膜外']);
  assert.equal(l.card.mandarin, '硬膜外');
});

test('every lesson line is one language: Mandarin lines have no pinyin, English lines no characters', () => {
  for (const e of ENTRIES) {
    const l = listenLesson(e, ENTRIES.length);
    for (const s of l.steps) {
      assert.ok(s.text.trim(), `${e.position} ${s.kind} has text`);
      if (s.lang === 'zh') {
        const withoutLetters = s.text.replace(/[xX]/g, ''); // e.g. 乳房x光片: the letter X is part of the term
        assert.doesNotMatch(withoutLetters, /[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i, `${e.position} ${s.kind}: no pinyin sent to the Mandarin voice`);
        assert.ok(HAN.test(s.text), `${e.position} ${s.kind}`);
      } else {
        assert.doesNotMatch(s.text, HAN, `${e.position} ${s.kind}: English line without characters`);
      }
    }
    assert.ok(l.steps.some((s) => s.kind === 'term'));
    assert.ok(l.steps.some((s) => s.kind === 'english'));
  }
});

test('no invented content: no sentence step (Volume 1 has none); syllables only when each character has one reading', () => {
  const shidao = listenLesson(ENTRIES[1], 385); // 食道: 食 has two readings (shí, sì)
  assert.equal(shidao.steps.some((s) => s.kind.startsWith('breakdown')), false);
  for (const e of ENTRIES) assert.equal(listenLesson(e, 385).steps.some((s) => /sentence/.test(s.kind)), false);
  const noPinyin = listenLesson(ENTRIES[160], 385); // position 161: no pinyin in the source
  assert.match(noPinyin.steps.find((s) => s.kind === 'pinyin').show, /no pinyin in the source/);
});

// ---------- the player (play / pause / repeat / next) ----------

function fakeLessons() {
  return (position = 1) => Promise.resolve({ position, total: 3, steps: [{ kind: 'a', text: `w${position}-1` }, { kind: 'b', text: `w${position}-2` }, { kind: 'c', text: `w${position}-3` }] });
}

// A step "plays" until the test finishes it (or it is stopped).
function manualAudio() {
  const played = [];
  let finish = null;
  return {
    played,
    playStep: (step) => new Promise((resolve) => { played.push(step.text); finish = resolve; }),
    stopAudio: () => { const f = finish; finish = null; f?.(); },
    end: async () => { const f = finish; finish = null; f?.(); await new Promise((r) => setImmediate(r)); },
  };
}

const tick = () => new Promise((r) => setImmediate(r));

test('player: plays the steps in order and finishes; Repeat after finishing plays the word again', async () => {
  const audio = manualAudio();
  const states = [];
  const p = new ListenController({ ...audio, loadLesson: fakeLessons(), onChange: (v) => states.push(v.state) });
  p.open(1);
  await tick();
  assert.equal(p.state, 'playing');
  await audio.end(); await audio.end(); await audio.end();
  assert.deepEqual(audio.played, ['w1-1', 'w1-2', 'w1-3']);
  assert.equal(p.state, 'finished');
  assert.equal(states[0], 'loading');
  p.repeat();
  await tick();
  assert.equal(audio.played.at(-1), 'w1-1', 'the whole word again');
  assert.equal(p.state, 'playing');
});

test('player: Pause stops, Play resumes the interrupted step, Repeat replays the current step', async () => {
  const audio = manualAudio();
  const p = new ListenController({ ...audio, loadLesson: fakeLessons() });
  p.open(1);
  await tick();
  await audio.end(); // step 1 done, step 2 playing
  assert.equal(p.view.index, 1);
  p.pause();
  await tick();
  assert.equal(p.state, 'paused');
  assert.equal(p.view.index, 1, 'stays on the interrupted step');
  assert.deepEqual(audio.played, ['w1-1', 'w1-2']);
  p.play();
  await tick();
  assert.equal(audio.played.at(-1), 'w1-2', 'resumes that step from its start');
  p.repeat();
  await tick();
  assert.equal(audio.played.at(-1), 'w1-2', 'repeat = this step again');
  assert.equal(p.state, 'playing');
  await audio.end(); await audio.end();
  assert.equal(p.state, 'finished');
});

test('player: Next moves one word forward in order, never past the last word; Exit clears', async () => {
  const audio = manualAudio();
  const opened = [];
  const load = fakeLessons();
  const p = new ListenController({ ...audio, loadLesson: (pos) => { opened.push(pos); return load(pos); } });
  p.open(1);
  await tick();
  p.next();
  await tick();
  assert.deepEqual(opened, [1, 2]);
  assert.equal(p.view.position, 2);
  assert.equal(audio.played.at(-1), 'w2-1');
  p.next();
  await tick();
  assert.equal(p.view.position, 3);
  assert.equal(p.view.canNext, false);
  p.next();
  await tick();
  assert.deepEqual(opened, [1, 2, 3], 'no word 4');
  p.exit();
  assert.equal(p.state, 'idle');
  assert.equal(p.lesson, null);
});

test('player: an audio failure keeps the text and moves on (the lesson does not stall)', async () => {
  const errors = [];
  let n = 0;
  const p = new ListenController({
    playStep: () => (++n === 2 ? Promise.reject(Object.assign(new Error('tts'), { code: 'tts_failed' })) : Promise.resolve()),
    loadLesson: fakeLessons(),
    onError: (e) => errors.push(e.code),
  });
  await p.open(1);
  assert.equal(p.state, 'finished');
  assert.deepEqual(errors, ['tts_failed']);
  assert.equal(p.failedSteps, 1);
});

test('the Listen code path never asks for the microphone', () => {
  const app = fs.readFileSync(path.join(appDir, 'public', 'app.js'), 'utf8');
  const listenPart = app.slice(app.indexOf('// ---------- Listen & Learn'));
  assert.ok(listenPart.length > 500);
  assert.doesNotMatch(listenPart, /getUserMedia|openMic\(|record\(|MediaRecorder|transcribe\(/);
  assert.match(app, /mode-listen'\)\.addEventListener\('click', \(\) => \{\s*unlockAudio\(\);[^}]*leaveInteractive\(\);/, 'entering Listen releases the microphone');
  const core = fs.readFileSync(path.join(appDir, 'public', 'voice-core.js'), 'utf8');
  const controller = core.slice(core.indexOf('export class ListenController'));
  assert.doesNotMatch(controller, /getUserMedia|MediaRecorder/);
});

// ---------- the real server ----------

const KEY = 'test-key-not-real-listen-9876';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN_|DASHSCOPE_|TUTOR_)/.test(k)));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

async function fakeTts() {
  const wav = Buffer.from(encodeWav(new Float32Array(2400).fill(0.1), 24000));
  const seen = { tts: [], chat: 0, asr: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url === '/tts') {
      seen.tts.push(JSON.parse(raw).input);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ output: { audio: { data: wav.toString('base64') } } }));
    }
    if (req.url.includes('chat/completions')) seen.chat += 1;
    if (req.url.includes('multimodal-generation')) seen.asr += 1;
    res.writeHead(500); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

test('GET /api/listen: Qwen TTS audio for each step, no teacher or ASR call, progress unchanged, key never sent', async () => {
  const q = await fakeTts();
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-listen-'));
  const base = `http://127.0.0.1:${q.port}`;
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: KEY, QWEN_BASE_URL: `${base}/teacher`, QWEN_ASR_BASE_URL: `${base}/asr`, QWEN_TTS_URL: `${base}/tts` };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('tutor on')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const url = `http://localhost:${port}`;
  const received = [];
  const getJson = async (p) => { const r = await fetch(url + p); const text = await r.text(); received.push(text); return { status: r.status, body: JSON.parse(text) }; };
  try {
    const before = (await getJson('/api/status')).body;
    assert.equal(before.position, 1);

    const lesson = (await getJson('/api/listen')).body;
    assert.equal(lesson.position, 1, 'defaults to Roy\'s current word');
    assert.equal(lesson.curriculumPosition, 1);
    assert.ok(lesson.steps.every((s) => /^[a-z0-9]+$/.test(s.audio)), 'every step has Qwen audio');
    for (const s of lesson.steps) {
      const a = await fetch(`${url}/api/voice/speech/${s.audio}`);
      assert.equal(a.status, 200);
      assert.equal(a.headers.get('content-type'), 'audio/wav');
    }
    const zh = q.seen.tts.filter((i) => i.language_type === 'Chinese').map((i) => i.text);
    const en = q.seen.tts.filter((i) => i.language_type === 'English').map((i) => i.text);
    assert.ok(zh.includes('硬膜外') && zh.includes('硬，膜，外'));
    assert.ok(en.includes('In English: epidural.'));
    assert.ok(q.seen.tts.every((i) => !/yìng|mó|wài/.test(i.text)), 'pinyin is never sent to TTS');
    const ttsCalls = q.seen.tts.length;
    assert.ok(ttsCalls < lesson.steps.length, 'the same text is synthesised once (term said three times)');

    // Repeat and Next: same word again reuses audio; next word is fetched by position.
    await getJson('/api/listen?position=1');
    assert.equal(q.seen.tts.length, ttsCalls, 'no new TTS for a repeat');
    const two = (await getJson('/api/listen?position=2')).body;
    assert.equal(two.position, 2);
    assert.equal(two.card.mandarin, '食道');
    assert.equal((await getJson('/api/listen?position=999')).status, 400);
    assert.equal((await getJson('/api/listen?position=abc')).status, 400);
    const textOnly = (await getJson('/api/listen?audio=0&position=3')).body;
    assert.ok(textOnly.steps.every((s) => !s.audio), 'text only: no TTS');

    // Listening changes nothing: no teacher, no ASR, no session, same place.
    assert.equal(q.seen.chat, 0, 'no Qwen teacher call');
    assert.equal(q.seen.asr, 0, 'no ASR call (no microphone)');
    const after = (await getJson('/api/status')).body;
    assert.equal(after.position, 1, 'progress unchanged after listening to words 1-3');
    assert.equal(after.completed ?? 0, before.completed ?? 0);
    assert.equal(after.session, null, 'no lesson session was started');

    for (const text of received) assert.ok(!text.includes(KEY) && !/DASHSCOPE_API_KEY=|Authorization|Bearer/.test(text), 'the key never reaches the browser');
    for (const page of ['/', '/app.js', '/voice-core.js']) assert.doesNotMatch(await (await fetch(url + page)).text(), new RegExp(KEY));
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    await q.close();
  }
});

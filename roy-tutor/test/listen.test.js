// Listen & Learn: lessons with practical usage, continuous play through the
// curriculum, Next/Repeat/Pause, listening progress, and no microphone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listenLesson, REQUIRED_STEPS } from '../src/listen.js';
import { checkListenContent, templateContent, createListenWriter } from '../src/listencontent.js';
import { ListenController, encodeWav } from '../public/voice-core.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /\p{Script=Han}/u;
const curriculum = JSON.parse(fs.readFileSync(path.join(appDir, 'data', 'jh-medics-vol1.json'), 'utf8'));
const ENTRIES = curriculum.entries ?? curriculum;
const SHIDAO = ENTRIES[1]; // 食道 shí dào esophagus

const TEACHER_SHIDAO = {
  sentence_zh: '医生说食道有炎症。',
  sentence_en: 'The doctor said there is inflammation in the esophagus.',
  usage_en: 'You may hear this word when doctors discuss swallowing problems or inflammation of the esophagus.',
  context_en: 'A patient says food gets stuck when swallowing, and the doctor explains the problem is in the esophagus.',
  source: 'teacher',
};

// ---------- the lesson ----------

test('a lesson has every part: word, pinyin, English, meaning, usage, sentence, translation, situation, word again', () => {
  assert.equal(SHIDAO.mandarin, '食道');
  const l = listenLesson(SHIDAO, 385, TEACHER_SHIDAO);
  const kinds = l.steps.map((s) => s.kind);
  for (const k of REQUIRED_STEPS) assert.ok(kinds.includes(k), `has ${k}`);
  const order = (k) => kinds.indexOf(k);
  for (const [a, b] of [['term', 'pinyin'], ['pinyin', 'english'], ['english', 'meaning'], ['meaning', 'usage'], ['usage', 'sentence'], ['sentence', 'sentence-en'], ['sentence-en', 'context'], ['context', 'repeat']]) {
    assert.ok(order(a) < order(b), `${a} before ${b}`);
  }
  assert.equal(l.steps.at(-1).kind, 'repeat', 'ends by saying the word again');
  const by = Object.fromEntries(l.steps.map((s) => [s.kind, s]));
  assert.deepEqual([by.term.lang, by.term.text], ['zh', '食道']);
  assert.equal(by.pinyin.text, '食道', 'the voice says the characters');
  assert.match(by.pinyin.show, /shí dào/, 'pinyin on screen');
  assert.equal(by.english.text, 'In English: esophagus.');
  assert.ok(by.meaning.text.includes(SHIDAO.meaning), 'JH Medics meaning, verbatim');
  assert.equal(by.meaning.source, 'curriculum');
  assert.deepEqual([by.sentence.lang, by.sentence.text], ['zh', '医生说食道有炎症。']);
  assert.ok(by.sentence.text.includes('食道'), 'the exact word in a sentence');
  assert.equal(by['sentence-en'].text, 'That means: The doctor said there is inflammation in the esophagus.');
  assert.match(by.usage.text, /^Where you will hear it: .*swallowing/);
  assert.match(by.context.text, /^In practice: .*patient.*doctor/);
  for (const k of ['usage', 'sentence', 'sentence-en', 'context']) assert.equal(by[k].source, 'teacher', `${k} is marked as the teacher's`);
  assert.deepEqual(l.example, { sentence_zh: '医生说食道有炎症。', sentence_en: 'The doctor said there is inflammation in the esophagus.', source: 'teacher' });
});

test('all 385 words: practical usage, a sentence with the exact word, medical context; one language per line', () => {
  assert.equal(ENTRIES.length, 385);
  for (const e of ENTRIES) {
    const l = listenLesson(e, ENTRIES.length, templateContent(e));
    const kinds = l.steps.map((s) => s.kind);
    for (const k of REQUIRED_STEPS) assert.ok(kinds.includes(k), `word ${e.position} has ${k}`);
    const sentence = l.steps.find((s) => s.kind === 'sentence').text;
    assert.ok(sentence.includes(e.mandarin.trim()), `word ${e.position}: sentence uses ${e.mandarin}`);
    assert.match(l.steps.find((s) => s.kind === 'usage').text, /doctors, nurses and patients/);
    assert.match(l.steps.find((s) => s.kind === 'context').text, /interpreter/);
    for (const s of l.steps) {
      assert.ok(s.text.trim(), `${e.position} ${s.kind} has text`);
      if (s.lang === 'zh') {
        const withoutTermLetters = s.text.replace(/[xX]/g, ''); // 乳房x光片: the letter X is part of the term
        assert.doesNotMatch(withoutTermLetters, /[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü]/i, `${e.position} ${s.kind}: no pinyin sent to the Mandarin voice`);
        assert.ok(HAN.test(s.text));
      } else {
        assert.doesNotMatch(s.text, HAN, `${e.position} ${s.kind}: English line without characters`);
      }
    }
  }
});

test('the teacher\'s example is checked: exact word, short, Mandarin only in the sentence, English only elsewhere', () => {
  assert.deepEqual(checkListenContent(SHIDAO, TEACHER_SHIDAO), []);
  const bad = (over) => checkListenContent(SHIDAO, { ...TEACHER_SHIDAO, ...over }).join('; ');
  assert.match(bad({ sentence_zh: '医生说食管有炎症。' }), /must contain the exact term 食道/, 'a synonym is not the curriculum word');
  assert.match(bad({ sentence_zh: '医生说食道 shí dào 有炎症。' }), /must not contain pinyin or English/);
  assert.match(bad({ sentence_zh: `医生说食道${'很'.repeat(40)}。` }), /longer than/);
  assert.match(bad({ sentence_en: 'The doctor said 食道 is inflamed.' }), /sentence_en must be English only/);
  assert.match(bad({ usage_en: '' }), /usage_en is missing/);
  assert.match(bad({ context_en: undefined }), /context_en is missing/);
  const xray = ENTRIES.find((e) => e.mandarin === '乳房x光片');
  assert.deepEqual(checkListenContent(xray, { ...TEACHER_SHIDAO, sentence_zh: '医生让她去拍乳房x光片。' }), [], 'letters that are part of the term are fine');
});

function fakeClient(replies) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (req) => {
      calls.push(req);
      const r = replies.shift();
      if (r instanceof Error) throw r;
      return { choices: [{ message: { content: typeof r === 'string' ? r : JSON.stringify(r) } }] };
    } } },
  };
}
const quietLog = { log() {}, warn() {} };

test('the Qwen writer: a good reply is used; a bad reply is corrected once; otherwise a plain template', async () => {
  const good = fakeClient([TEACHER_SHIDAO]);
  const w = createListenWriter({ client: good, env: {}, log: quietLog });
  const r = await w.write(SHIDAO);
  assert.equal(r.source, 'teacher');
  assert.equal(r.content.sentence_zh, '医生说食道有炎症。');
  const prompt = good.calls[0].messages[0].content;
  assert.match(prompt, /contains the exact Mandarin term/);
  assert.match(prompt, /No unrelated vocabulary/);
  assert.equal(JSON.parse(good.calls[0].messages[1].content).mandarin, '食道');

  const fixed = fakeClient([{ ...TEACHER_SHIDAO, sentence_zh: '他的喉咙很痛。' }, TEACHER_SHIDAO]);
  assert.equal((await createListenWriter({ client: fixed, env: {}, log: quietLog }).write(SHIDAO)).source, 'teacher');
  assert.match(fixed.calls[1].messages.at(-1).content, /must contain the exact term 食道/);

  const hopeless = fakeClient([{ sentence_zh: 'x' }, 'not json']);
  const t = await createListenWriter({ client: hopeless, env: {}, log: quietLog }).write(SHIDAO);
  assert.equal(t.source, 'template');
  assert.ok(t.content.sentence_zh.includes('食道'));

  const none = await createListenWriter({ env: {}, log: quietLog }).write(SHIDAO);
  assert.equal(none.source, 'template', 'no key: template, no request');
});

// ---------- continuous play ----------

const lessons = (total = 3) => (position = 1) => Promise.resolve({ position, total, steps: [{ kind: 'a', text: `w${position}-1` }, { kind: 'b', text: `w${position}-2` }] });
const tick = () => new Promise((r) => setImmediate(r));

// Audio that plays instantly, recording what was played.
function autoAudio() {
  const played = [];
  return { played, playStep: async (step) => { played.push(step.text); } };
}

// Audio that plays until the test ends it.
function manualAudio() {
  const played = [];
  let finish = null;
  return {
    played,
    playStep: (step) => new Promise((resolve) => { played.push(step.text); finish = resolve; }),
    stopAudio: () => { const f = finish; finish = null; f?.(); },
    end: async () => { const f = finish; finish = null; f?.(); for (let i = 0; i < 5; i++) await tick(); },
  };
}

test('continuous play: after a word finishes, the next word starts by itself (no Next click) until the last word', async () => {
  const audio = autoAudio();
  const completed = [];
  const loads = [];
  const load = lessons(3);
  const p = new ListenController({ ...audio, loadLesson: (pos) => { loads.push(pos); return load(pos); }, onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  await p.open(undefined);
  assert.deepEqual(audio.played, ['w1-1', 'w1-2', 'w2-1', 'w2-2', 'w3-1', 'w3-2'], 'three words in order, no clicks');
  assert.deepEqual(completed, [1, 2, 3], 'each word counted once it had fully played');
  assert.equal(p.state, 'finished', 'stops after the last word of the curriculum');
  assert.equal(p.view.position, 3);
  assert.deepEqual(loads, [undefined, 2, 3], 'each next word fetched once (prefetched while the previous one played)');
});

test('auto-advance waits a short gap between words; Pause during the gap stops it', async () => {
  let release;
  const gap = new Promise((r) => { release = r; });
  const audio = autoAudio();
  const p = new ListenController({ ...audio, loadLesson: lessons(3), wait: () => gap });
  p.open(1);
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(p.state, 'gap');
  assert.equal(p.view.position, 1);
  p.pause();
  release();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(p.state, 'paused');
  assert.equal(p.view.position, 1, 'did not move on while paused');
  p.play();
  for (let i = 0; i < 10; i++) await tick();
  assert.equal(p.view.position >= 2, true, 'Play after the gap continues with the next word');
});

test('Next skips to the next word now; a skipped word is not counted as listened', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(1);
  await tick();
  assert.deepEqual(audio.played, ['w1-1']);
  p.next();
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(p.view.position, 2);
  assert.equal(audio.played.at(-1), 'w2-1');
  await audio.end(); await audio.end();
  assert.deepEqual(completed, [2], 'word 1 was skipped, word 2 finished');
  assert.equal(p.view.position, 3, 'and it went on to word 3 by itself');
  p.next();
  await tick();
  assert.equal(p.view.position, 3, 'never past the last word');
});

test('Repeat replays the current word\'s whole lesson from the start', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => new Promise(() => {}) });
  p.open(1);
  await tick();
  await audio.end(); // w1-1 done, w1-2 playing
  assert.deepEqual(audio.played, ['w1-1', 'w1-2']);
  p.repeat();
  await tick();
  assert.equal(audio.played.at(-1), 'w1-1', 'from the first step');
  assert.equal(p.view.position, 1);
  await audio.end(); await audio.end();
  assert.deepEqual(audio.played, ['w1-1', 'w1-2', 'w1-1', 'w1-2']);
  assert.deepEqual(completed, [1]);
});

test('Pause and Play resume the interrupted step; the word still counts once every step has played', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => new Promise(() => {}) });
  p.open(1);
  await tick();
  await audio.end(); // step 1 done
  p.pause();
  assert.equal(p.state, 'paused');
  p.play();
  await tick();
  assert.equal(audio.played.at(-1), 'w1-2', 'the interrupted step again');
  await audio.end();
  assert.deepEqual(completed, [1]);
});

test('a word whose audio failed is not counted as listened, but the lesson still moves on', async () => {
  let n = 0;
  const completed = [];
  const p = new ListenController({
    playStep: () => (++n === 2 ? Promise.reject(Object.assign(new Error('tts'), { code: 'tts_failed' })) : Promise.resolve()),
    loadLesson: lessons(2),
    onComplete: (l) => completed.push(l.position),
    wait: () => Promise.resolve(),
  });
  await p.open(1);
  assert.deepEqual(completed, [2], 'word 1 had a failed step; word 2 played fully');
  assert.equal(p.state, 'finished');
});

test('the Listen code path never asks for the microphone', () => {
  const app = fs.readFileSync(path.join(appDir, 'public', 'app.js'), 'utf8');
  const listenPart = app.slice(app.indexOf('// ---------- Listen & Learn'));
  assert.ok(listenPart.length > 500);
  assert.doesNotMatch(listenPart, /getUserMedia|openMic\(|record\(|MediaRecorder|transcribe\(/);
  assert.match(app, /mode-listen'\)\.addEventListener\('click', \(\) => \{\s*unlockAudio\(\);[^}]*leaveInteractive\(\);/, 'entering Listen releases the microphone');
  const core = fs.readFileSync(path.join(appDir, 'public', 'voice-core.js'), 'utf8');
  assert.doesNotMatch(core.slice(core.indexOf('export class ListenController')), /getUserMedia|MediaRecorder/);
});

// ---------- the real server ----------

const KEY = 'test-key-not-real-listen-9876';
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN_|DASHSCOPE_|TUTOR_)/.test(k)));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// Stand-in for Qwen: the listen writer (chat) and TTS. Anything else is counted.
async function fakeQwen() {
  const wav = Buffer.from(encodeWav(new Float32Array(2400).fill(0.1), 24000));
  const seen = { tts: [], writer: [], teacherTurns: 0, asr: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/tts') { seen.tts.push(JSON.parse(raw).input); return json({ output: { audio: { data: wav.toString('base64') } } }); }
    if (req.url === '/teacher/chat/completions') {
      const body = JSON.parse(raw);
      if (/listening material/.test(body.messages[0].content)) {
        const entry = JSON.parse(body.messages[1].content);
        seen.writer.push(entry.mandarin);
        const content = { sentence_zh: `医生说${entry.mandarin}需要检查。`, sentence_en: `The doctor said the ${entry.english} needs to be checked.`, usage_en: `Doctors use this word when examining the ${entry.english}.`, context_en: `A doctor tells a patient, through the interpreter, that the ${entry.english} needs to be checked.` };
        return json({ id: 'w', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
      }
      seen.teacherTurns += 1;
    }
    if (req.url.includes('multimodal-generation')) seen.asr += 1;
    res.writeHead(500); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

test('server: lessons with the teacher\'s example (written once), listening progress N → N+1, sequential, Interactive Practice untouched', async () => {
  const q = await fakeQwen();
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
  const call = async (method, p, body) => {
    const r = await fetch(url + p, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    received.push(text);
    return { status: r.status, body: JSON.parse(text) };
  };
  try {
    const before = (await call('GET', '/api/status')).body;
    assert.equal(before.position, 1);

    // Word 1: teacher example, practical usage, every step with Qwen audio.
    const one = (await call('GET', '/api/listen')).body;
    assert.equal(one.position, 1, 'listening starts at word 1');
    assert.equal(one.listenPosition, 1);
    const sentence = one.steps.find((s) => s.kind === 'sentence');
    assert.equal(sentence.text, '医生说硬膜外需要检查。');
    assert.equal(sentence.source, 'teacher');
    assert.ok(one.steps.find((s) => s.kind === 'usage').text.includes('epidural'));
    assert.ok(one.steps.find((s) => s.kind === 'context').text.includes('interpreter'));
    assert.ok(one.steps.every((s) => /^[a-z0-9]+$/.test(s.audio)), 'every step has Qwen audio');
    assert.equal((await fetch(`${url}/api/voice/speech/${sentence.audio}`)).status, 200);
    assert.ok(q.seen.tts.some((i) => i.text === '医生说硬膜外需要检查。' && i.language_type === 'Chinese'));
    assert.ok(q.seen.tts.every((i) => !/yìng|mó|wài/.test(i.text)), 'pinyin is never sent to TTS');

    // Written once: fetching word 1 again (Repeat) asks Qwen for nothing new.
    const tts = q.seen.tts.length;
    await call('GET', '/api/listen?position=1');
    assert.deepEqual(q.seen.writer, ['硬膜外'], 'the example was written once and stored');
    assert.equal(q.seen.tts.length, tts, 'no new TTS for a repeat');

    // Fetching (or starting) a lesson does not count it as listened.
    assert.equal((await call('GET', '/api/listen?position=2')).body.listenPosition, 1, 'generating audio is not finishing a lesson');

    // Finishing word 1 moves listening to word 2.
    const done1 = (await call('POST', '/api/listen/complete', { position: 1 })).body;
    assert.deepEqual([done1.finished, done1.listenPosition, done1.listened], [1, 2, 1]);
    assert.equal((await call('GET', '/api/listen')).body.position, 2, 'continues at word 2');

    // Sequential: word 2 skipped, word 3 finished → listening still continues at 2.
    const done3 = (await call('POST', '/api/listen/complete', { position: 3 })).body;
    assert.equal(done3.listenPosition, 2, 'a skipped word stays unfinished');
    const done2 = (await call('POST', '/api/listen/complete', { position: 2 })).body;
    assert.equal(done2.listenPosition, 4, 'after word 2, words 1-3 are done: continue at 4');
    assert.equal(done2.listened, 3);
    assert.equal((await call('POST', '/api/listen/complete', { position: 999 })).status, 400);
    assert.equal((await call('GET', '/api/listen?position=0')).status, 400);

    // Interactive Practice is untouched: same place, nothing completed, no session, no teacher turn, no ASR.
    const after = (await call('GET', '/api/status')).body;
    assert.equal(after.position, 1, 'Interactive Practice still at word 1');
    assert.equal(after.completed ?? 0, before.completed ?? 0);
    assert.equal(after.session, null);
    assert.equal(q.seen.teacherTurns, 0);
    assert.equal(q.seen.asr, 0, 'no microphone, no ASR');

    for (const text of received) assert.ok(!text.includes(KEY) && !/DASHSCOPE_API_KEY=|Authorization|Bearer/.test(text), 'the key never reaches the browser');
    for (const page of ['/', '/app.js', '/voice-core.js']) assert.doesNotMatch(await (await fetch(url + page)).text(), new RegExp(KEY));
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
    await q.close();
  }
});

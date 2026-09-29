// Listen & Learn: lessons with practical usage, continuous play through the
// curriculum, Next/Repeat/Pause/resume, and no microphone. (Progress and the
// server routes: progress.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenLesson, REQUIRED_STEPS, REVIEW_STEPS } from '../src/listen.js';
import { checkListenContent, templateContent, createListenWriter } from '../src/listencontent.js';
import { ListenController, listenStatusText } from '../public/voice-core.js';

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

test('a review lesson (new study day) is the short version: word, pinyin, English, sentence, translation, word again', () => {
  const l = listenLesson(SHIDAO, 385, TEACHER_SHIDAO, { review: true });
  const kinds = l.steps.map((s) => s.kind);
  for (const k of REVIEW_STEPS) assert.ok(kinds.includes(k), `has ${k}`);
  assert.ok(!kinds.includes('meaning') && !kinds.includes('usage'), 'short');
  assert.match(l.steps[0].text, /^Review: word 2\./);
  assert.equal(l.steps.at(-1).text, '食道');
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

// Lessons as the server sends them: each says what follows it.
const lessons = (total = 3, { review = [] } = {}) => (target) => {
  const position = target?.position ?? (review.length ? review[0] : 1);
  const isReview = target ? Boolean(target.review) : review.length > 0;
  let next = null;
  if (isReview) {
    const i = review.indexOf(position);
    next = i + 1 < review.length ? { position: review[i + 1], review: true } : { position: 1, review: false };
  } else if (position < total) next = { position: position + 1, review: false };
  const tag = `${isReview ? 'r' : 'w'}${position}`;
  return Promise.resolve({ position, review: isReview, total, next, steps: [{ kind: 'a', text: `${tag}-1` }, { kind: 'b', text: `${tag}-2` }] });
};
const tick = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

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
    end: async () => { const f = finish; finish = null; f?.(); await settle(); },
  };
}

test('continuous play: each lesson is followed by the next one by itself (no Next click) until the end of the curriculum', async () => {
  const audio = autoAudio();
  const completed = [];
  const loads = [];
  const load = lessons(3);
  const p = new ListenController({ ...audio, loadLesson: (t) => { loads.push(t ? t.position : 'now'); return load(t); }, onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  await p.open(undefined);
  assert.deepEqual(audio.played, ['w1-1', 'w1-2', 'w2-1', 'w2-2', 'w3-1', 'w3-2'], 'three words in order, no clicks');
  assert.deepEqual(completed, [1, 2, 3], 'each word reported once it had fully played');
  assert.equal(p.state, 'finished', 'stops after the last word');
  assert.deepEqual(loads, ['now', 2, 3], 'each following lesson fetched once, while the previous one played');
});

test('a new study day: review lessons first, then the current word, all without clicks', async () => {
  const audio = autoAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(2, { review: [7, 9] }), onComplete: (l) => completed.push(`${l.review ? 'r' : 'w'}${l.position}`), wait: () => Promise.resolve() });
  await p.open(undefined);
  assert.deepEqual(audio.played, ['r7-1', 'r7-2', 'r9-1', 'r9-2', 'w1-1', 'w1-2', 'w2-1', 'w2-2']);
  assert.deepEqual(completed, ['r7', 'r9', 'w1', 'w2']);
});

test('a short pause between lessons; Pause during it stops the flow, Play continues with the next lesson', async () => {
  let release;
  const gap = new Promise((r) => { release = r; });
  const audio = autoAudio();
  let waits = 0;
  const p = new ListenController({ ...audio, loadLesson: lessons(3), wait: () => (++waits === 1 ? gap : new Promise(() => {})) });
  p.open({ position: 1, review: false });
  await settle();
  assert.equal(p.state, 'gap');
  p.pause();
  release();
  await settle();
  assert.equal(p.state, 'paused');
  assert.equal(p.view.position, 1, 'did not move on while paused');
  p.play();
  await settle();
  assert.equal(p.view.position, 2);
});

test('Next skips to the following lesson now; a skipped lesson is not reported as listened', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(undefined);
  await settle();
  assert.deepEqual(audio.played, ['w1-1']);
  p.next();
  await settle();
  assert.equal(p.view.position, 2);
  await audio.end(); await audio.end();
  assert.deepEqual(completed, [2], 'word 1 was skipped, word 2 finished');
  assert.equal(p.view.position, 3, 'and word 3 followed by itself');
  assert.equal(p.view.canNext, false);
  p.next();
  await settle();
  assert.equal(p.view.position, 3, 'never past the last word');
});

test('Repeat plays the current lesson again from the start', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => new Promise(() => {}) });
  p.open(undefined);
  await settle();
  await audio.end(); // step 1 done, step 2 playing
  p.repeat();
  await settle();
  assert.equal(audio.played.at(-1), 'w1-1', 'from the first step');
  await audio.end(); await audio.end();
  assert.deepEqual(audio.played, ['w1-1', 'w1-2', 'w1-1', 'w1-2']);
  assert.deepEqual(completed, [1]);
});

test('Pause keeps the place; Play resumes the interrupted step; the lesson still counts', async () => {
  const audio = manualAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: lessons(3), onComplete: (l) => completed.push(l.position), wait: () => new Promise(() => {}) });
  p.open(undefined);
  await settle();
  await audio.end(); // step 1 done
  p.pause();
  assert.equal(p.state, 'paused');
  assert.equal(p.view.index, 1);
  p.play();
  await settle();
  assert.equal(audio.played.at(-1), 'w1-2', 'the interrupted step again');
  await audio.end();
  assert.deepEqual(completed, [1]);
});

test('a failed audio line: the player stops on it, the word is not completed, Play retries that line and then continues', async () => {
  let failing = true;
  const played = [];
  const completed = [];
  const errors = [];
  const p = new ListenController({
    playStep: async (step) => {
      if (step.text === 'w1-2' && failing) throw Object.assign(new Error('tts'), { code: 'tts_failed' });
      played.push(step.text);
    },
    loadLesson: lessons(2),
    onComplete: (l) => completed.push(l.position),
    onError: (e) => errors.push(e.code),
    wait: () => Promise.resolve(),
  });
  await p.open(undefined);
  assert.equal(p.state, 'paused', 'stops on the failed line (no advance)');
  assert.equal(p.view.position, 1);
  assert.equal(p.view.index, 1, 'on the failed line');
  assert.equal(p.view.problem, 'audio');
  assert.match(listenStatusText(p.view), /^Word 1: this line's audio could not be played, so Word 1 is not complete\. ▶ Play tries again/);
  assert.deepEqual(completed, [], 'not completed');
  assert.deepEqual(errors, ['tts_failed'], 'the error is reported');
  await settle();
  assert.equal(p.view.position, 1, 'still Word 1 later: nothing advances by itself');

  failing = false;
  p.play(); // retry
  await settle();
  assert.deepEqual(played, ['w1-1', 'w1-2', 'w2-1', 'w2-2'], 'the failed line again, then on as usual');
  assert.deepEqual(completed, [1, 2]);
  assert.equal(p.state, 'finished');

  const silent = new ListenController({ playStep: () => Promise.reject(Object.assign(new Error('tts'), { code: 'tts_failed' })), loadLesson: lessons(3), onError: (e) => errors.push(e.code), wait: () => Promise.resolve() });
  await silent.open(undefined);
  assert.equal(silent.state, 'paused', 'no voice at all: stops at once');
  assert.equal(silent.view.position, 1);
  assert.equal(silent.view.index, 0);
});

test('each line is played with only the NEXT line as look-ahead (never the whole lesson or the next word)', async () => {
  const calls = [];
  const p = new ListenController({
    playStep: async (step, { next }) => { calls.push([step.text, next?.text ?? null]); },
    loadLesson: lessons(2),
    wait: () => Promise.resolve(),
  });
  await p.open(undefined);
  assert.deepEqual(calls, [['w1-1', 'w1-2'], ['w1-2', null], ['w2-1', 'w2-2'], ['w2-2', null]]);
});

test('Qwen voice rate-limited (429 after the server\'s retries): pauses on that line, says so, completes nothing; Play retries', async () => {
  let limited = true;
  const played = [];
  const completed = [];
  const errors = [];
  const p = new ListenController({
    playStep: async (step) => {
      if (step.text === 'w1-2' && limited) throw Object.assign(new Error('rate limited'), { code: 'tts_rate_limited' });
      played.push(step.text);
    },
    loadLesson: lessons(2),
    onComplete: (l) => completed.push(l.position),
    onError: (e) => errors.push(e.code),
    wait: () => Promise.resolve(),
  });
  await p.open(undefined);
  assert.equal(p.state, 'paused');
  assert.equal(p.view.problem, 'rate_limited');
  assert.match(listenStatusText(p.view), /rate limit.*Word 1 is paused, not complete.*▶ Play to retry/);
  assert.deepEqual(completed, []);
  assert.deepEqual(errors, ['tts_rate_limited']);
  await settle();
  assert.deepEqual(played, ['w1-1'], 'no automatic retry loop in the page');
  limited = false;
  p.play();
  await settle();
  assert.deepEqual(played, ['w1-1', 'w1-2', 'w2-1', 'w2-2']);
  assert.deepEqual(completed, [1, 2]);
});

test('a failed save: the word is heard but not recorded, the player pauses; Play saves it and continues', async () => {
  let online = false;
  const completed = [];
  const p = new ListenController({
    ...autoAudio(),
    loadLesson: lessons(2),
    onComplete: async (l) => { if (!online) throw Object.assign(new TypeError('Failed to fetch'), { code: 'network' }); completed.push(l.position); },
    wait: () => Promise.resolve(),
  });
  await p.open(undefined);
  assert.equal(p.state, 'paused');
  assert.equal(p.view.position, 1, 'does not move on to Word 2 while Word 1 is unsaved');
  assert.equal(p.view.problem, 'not_saved');
  assert.match(listenStatusText(p.view), /was heard in full but could not be saved/);
  online = true;
  p.play();
  await settle();
  assert.deepEqual(completed, [1, 2]);
  assert.equal(p.state, 'finished');
});

test('network failure pauses at the same step (no racing ahead); Play retries', async () => {
  let online = false;
  const played = [];
  const completed = [];
  const p = new ListenController({
    playStep: async (step) => { if (!online) throw Object.assign(new TypeError('Failed to fetch'), { code: 'network' }); played.push(step.text); },
    loadLesson: lessons(2),
    onComplete: (l) => completed.push(l.position),
    wait: () => new Promise(() => {}),
  });
  await p.open(undefined);
  assert.equal(p.state, 'paused');
  assert.equal(p.view.index, 0, 'still on the first step');
  online = true;
  p.play();
  await settle();
  assert.deepEqual(played, ['w1-1', 'w1-2']);
  assert.deepEqual(completed, [1]);

  // A lesson that cannot even be loaded: paused, Play loads it again.
  let fail = true;
  const load = lessons(2);
  const q = new ListenController({ playStep: async () => {}, loadLesson: (t) => (fail ? Promise.reject(Object.assign(new TypeError('Failed to fetch'), { code: 'network' })) : load(t)), wait: () => new Promise(() => {}) });
  await q.open(undefined);
  assert.equal(q.state, 'paused');
  fail = false;
  q.play();
  await settle();
  assert.equal(q.view.position, 1);
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


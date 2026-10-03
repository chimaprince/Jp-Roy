// Listen & Learn: lessons with practical usage, continuous play through the
// curriculum, Next/Repeat/Pause/resume, and no microphone. (Progress and the
// server routes: progress.test.js.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenLesson, REQUIRED_STEPS, REVIEW_STEPS } from '../src/listen.js';
import { checkListenContent, cleanDialogue, templateContent, createListenWriter } from '../src/listencontent.js';
import { ListenController, listenStatusText, listenWhereText } from '../public/voice-core.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HAN = /\p{Script=Han}/u;
const curriculum = JSON.parse(fs.readFileSync(path.join(appDir, 'data', 'jh-medics-vol1.json'), 'utf8'));
const ENTRIES = curriculum.entries ?? curriculum;
const SHIDAO = ENTRIES[1]; // 食道 shí dào esophagus

const TEACHER_SHIDAO = {
  v: 2,
  explanation_en: 'The esophagus is the tube that carries food from the throat to the stomach.',
  usage_en: 'You may hear this word when doctors discuss swallowing problems or inflammation of the esophagus.',
  sentence_zh: '医生说食道有炎症。',
  sentence_en: 'The doctor said there is inflammation in the esophagus.',
  context_en: 'A patient says food gets stuck when swallowing, and the doctor explains the problem is in the esophagus.',
  dialogue: [
    { speaker: '医生', zh: '你吞东西的时候食道疼吗？', en: 'Does your esophagus hurt when you swallow?' },
    { speaker: '患者', zh: '有一点疼。', en: 'It hurts a little.' },
  ],
  source: 'teacher',
};

// ---------- the lesson ----------

test('a lesson teaches the word: term (pinyin on screen), English + explanation + practical usage, example, translation + interpreter situation, dialogue, term again', () => {
  assert.equal(SHIDAO.mandarin, '食道');
  const l = listenLesson(SHIDAO, 385, TEACHER_SHIDAO);
  const kinds = l.steps.map((s) => s.kind);
  assert.deepEqual(kinds, ['intro', 'term', 'explain', 'sentence', 'sentence-en', 'dialogue', 'dialogue-en', 'recap'], 'the standard teaching order');
  for (const k of REQUIRED_STEPS) assert.ok(kinds.includes(k), `has ${k}`);
  const by = Object.fromEntries(l.steps.map((s) => [s.kind, s]));
  assert.deepEqual([by.intro.lang, by.intro.text], ['zh', '我们来学一个医学词语：食道。'], 'the teacher introduces the word in Mandarin');
  assert.deepEqual([by.term.lang, by.term.text], ['zh', '食道'], 'the voice says the characters');
  assert.match(by.term.show, /食道 {2}shí dào/, 'pinyin on screen, not spoken');
  assert.equal(by.term.rate, 0.8, 'the term slowly, for a learner');
  assert.equal(by.term.source, 'curriculum');
  assert.equal(by.explain.lang, 'en');
  assert.equal(by.explain.text, `Esophagus. ${TEACHER_SHIDAO.explanation_en} ${TEACHER_SHIDAO.usage_en} For example:`);
  assert.equal(by.explain.source, 'teacher', 'the explanation is marked as the AI teacher\'s, not JH Medics\'');
  assert.deepEqual([by.sentence.lang, by.sentence.text], ['zh', '医生说食道有炎症。']);
  assert.equal(by['sentence-en'].text, `That means: The doctor said there is inflammation in the esophagus. ${TEACHER_SHIDAO.context_en} Here is a short conversation.`);
  assert.equal(by.dialogue.text, '医生：你吞东西的时候食道疼吗？ 患者：有一点疼。');
  assert.equal(by['dialogue-en'].text, 'Doctor: Does your esophagus hurt when you swallow? Patient: It hurts a little.');
  assert.deepEqual([by.recap.lang, by.recap.text], ['zh', '再听一次：食道。医生说食道有炎症。'], 'ends with the word and the sentence once more, in Mandarin');
  // The teaching layer as structured data.
  assert.deepEqual(l.teaching, {
    source: 'teacher', explanation_en: TEACHER_SHIDAO.explanation_en, usage_en: TEACHER_SHIDAO.usage_en,
    sentence_zh: TEACHER_SHIDAO.sentence_zh, sentence_en: TEACHER_SHIDAO.sentence_en, context_en: TEACHER_SHIDAO.context_en, dialogue: TEACHER_SHIDAO.dialogue,
  });
  // A few natural audio segments (8 here), each made once.
  assert.equal(new Set(l.steps.map((s) => s.text)).size, 8);
  const plain = listenLesson(SHIDAO, 385, { ...TEACHER_SHIDAO, dialogue: [] });
  assert.deepEqual(plain.steps.map((s) => s.kind), ['intro', 'term', 'explain', 'sentence', 'sentence-en', 'recap'], 'no dialogue: 6 segments');
  assert.doesNotMatch(plain.steps[4].text, /conversation/);
});

test('all 385 words: explanation, practical usage, a sentence with the exact word, translation, medical context; one language per line; at most 8 audio segments', () => {
  assert.equal(ENTRIES.length, 385);
  for (const e of ENTRIES) {
    const l = listenLesson(e, ENTRIES.length, templateContent(e));
    const kinds = l.steps.map((s) => s.kind);
    for (const k of REQUIRED_STEPS) assert.ok(kinds.includes(k), `word ${e.position} has ${k}`);
    const by = Object.fromEntries(l.steps.map((s) => [s.kind, s]));
    assert.ok(by.sentence.text.includes(e.mandarin.trim()), `word ${e.position}: sentence uses ${e.mandarin}`);
    assert.match(by.explain.text, /doctors, nurses and patients/, 'practical usage');
    assert.match(by['sentence-en'].text, /^That means: .*interpreter/, 'translation and interpreter situation');
    if (e.meaning) assert.ok(by.explain.text.includes('JH Medics defines it as:'), 'template explanation quotes the source, labelled');
    assert.ok(new Set(l.steps.map((s) => s.text)).size <= 8, `word ${e.position}: at most 8 TTS requests`);
    assert.ok(by.recap.text.includes(e.mandarin.trim()), 'the recap says the word again');
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

test('a review lesson (new study day) is the short version: word, English, sentence, translation, word again', () => {
  const l = listenLesson(SHIDAO, 385, TEACHER_SHIDAO, { review: true });
  assert.deepEqual(l.steps.map((s) => s.kind), REVIEW_STEPS);
  assert.equal(l.steps[0].text, '复习一个医学词语：食道。');
  assert.equal(l.steps[2].text, 'Review. Esophagus. For example:');
  assert.equal(l.steps.at(-1).text, '再听一次：食道。医生说食道有炎症。');
  assert.ok(!l.steps.some((s) => s.kind === 'dialogue'), 'short');
});

test('the teacher\'s material is checked: exact word, short, Mandarin only in the sentence, English only elsewhere; a bad dialogue is dropped', () => {
  assert.deepEqual(checkListenContent(SHIDAO, TEACHER_SHIDAO), []);
  const bad = (over) => checkListenContent(SHIDAO, { ...TEACHER_SHIDAO, ...over }).join('; ');
  assert.match(bad({ sentence_zh: '医生说食管有炎症。' }), /must contain the exact term 食道/, 'a synonym is not the curriculum word');
  assert.match(bad({ sentence_zh: '医生说食道 shí dào 有炎症。' }), /must not contain pinyin or English/);
  assert.match(bad({ sentence_zh: `医生说食道${'很'.repeat(40)}。` }), /longer than/);
  assert.match(bad({ sentence_en: 'The doctor said 食道 is inflamed.' }), /sentence_en must be English only/);
  assert.match(bad({ usage_en: '' }), /usage_en is missing/);
  assert.match(bad({ explanation_en: undefined }), /explanation_en is missing/);
  assert.match(bad({ context_en: undefined }), /context_en is missing/);
  const xray = ENTRIES.find((e) => e.mandarin === '乳房x光片');
  assert.deepEqual(checkListenContent(xray, { ...TEACHER_SHIDAO, sentence_zh: '医生让她去拍乳房x光片。' }), [], 'letters that are part of the term are fine');
  // The dialogue is optional; a wrong one is dropped, never played.
  assert.deepEqual(cleanDialogue(SHIDAO, TEACHER_SHIDAO.dialogue), TEACHER_SHIDAO.dialogue);
  assert.deepEqual(cleanDialogue(SHIDAO, []), []);
  assert.deepEqual(cleanDialogue(SHIDAO, [{ speaker: '医生', zh: '你好。', en: 'Hello.' }, { speaker: '患者', zh: '你好。', en: 'Hello.' }]), [], 'no line with the term');
  assert.deepEqual(cleanDialogue(SHIDAO, [{ speaker: '医生', zh: '食道 shí dào 疼吗？', en: 'Pain?' }, { speaker: '患者', zh: '疼。', en: 'Yes.' }]), [], 'pinyin in a Mandarin line');
  assert.deepEqual(cleanDialogue(SHIDAO, [{ speaker: 'Teacher', zh: '食道疼吗？', en: 'Pain?' }, { speaker: '患者', zh: '疼。', en: 'Yes.' }]), [], 'unknown speaker');
  assert.deepEqual(cleanDialogue(SHIDAO, [{ speaker: '医生', zh: '食道疼吗？', en: '食道 pain?' }, { speaker: '患者', zh: '疼。', en: 'Yes.' }]), [], 'Chinese in an English line');
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

test('the Qwen writer: generates the teaching layer (the curriculum has no examples); a bad reply is corrected once; otherwise a plain template', async () => {
  const { source: _s, v: _v, ...reply } = TEACHER_SHIDAO;
  const good = fakeClient([reply]);
  const w = createListenWriter({ client: good, env: {}, log: quietLog });
  const r = await w.write(SHIDAO);
  assert.equal(r.source, 'teacher');
  assert.equal(r.content.v, 2);
  assert.equal(r.content.sentence_zh, '医生说食道有炎症。');
  assert.equal(r.content.explanation_en, TEACHER_SHIDAO.explanation_en);
  assert.deepEqual(r.content.dialogue, TEACHER_SHIDAO.dialogue);
  const prompt = good.calls[0].messages[0].content;
  assert.match(prompt, /JH Medics has no examples, so the explanation and examples are yours/);
  assert.match(prompt, /containing the exact Mandarin term/);
  assert.match(prompt, /do not invent unsupported medical facts/);
  assert.match(prompt, /Stay in medical communication/);
  const facts = JSON.parse(good.calls[0].messages[1].content);
  assert.deepEqual([facts.mandarin, facts.pinyin, facts.english, facts.jh_medics_meaning], ['食道', SHIDAO.pinyin, SHIDAO.english, SHIDAO.meaning], 'the curriculum entry is what Qwen teaches from');

  const noDialogue = await createListenWriter({ client: fakeClient([{ ...reply, dialogue: [{ speaker: '医生', zh: 'bad', en: 'x' }] }]), env: {}, log: quietLog }).write(SHIDAO);
  assert.equal(noDialogue.source, 'teacher', 'a bad dialogue alone does not reject the lesson');
  assert.deepEqual(noDialogue.content.dialogue, []);

  const fixed = fakeClient([{ ...reply, sentence_zh: '他的喉咙很痛。' }, reply]);
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
  assert.match(listenStatusText(p.view), /^Audio temporarily unavailable\. Word 1 is not complete\. ↻ Retry plays it again/);
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

test('look-ahead is one clip: the next line, and on a word\'s last line the next word\'s first line (never a whole lesson)', async () => {
  const calls = [];
  const p = new ListenController({
    playStep: async (step, { next }) => { calls.push([step.text, next?.text ?? null]); },
    loadLesson: lessons(2),
    wait: () => Promise.resolve(),
  });
  await p.open(undefined);
  assert.deepEqual(calls, [['w1-1', 'w1-2'], ['w1-2', 'w2-1'], ['w2-1', 'w2-2'], ['w2-2', null]]);
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
  assert.match(listenStatusText(p.view), /^Audio temporarily unavailable: .*rate limit.*Word 1 is not complete.*↻ Retry/);
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


test('the page wording: one shared place, never "press Next"; which word plays vs. where the place is', () => {
  const lesson = (position, extra = {}) => ({ position, total: 385, review: false, ...extra });
  assert.equal(listenWhereText(lesson(2), 2, 1), 'Now teaching: Word 2 of 385 · 1 word listened');
  assert.equal(listenWhereText(lesson(3), 1, 2), 'Now playing: Word 3 of 385, ahead of your place · your place stays at Word 1 (skipped, not completed yet) · 2 words listened');
  assert.match(listenWhereText(lesson(4, { review: true, reviewIndex: 0, reviewCount: 2 }), 9), /^Review 1 of 2 · Word 4/);
  assert.equal(listenWhereText(lesson(1), 2, 1), 'Word 1 of 385 complete · your place is now Word 2 · 1 word listened', 'the moment between two words');
  const view = { state: 'gap', position: 1, review: false, next: { position: 2, review: false }, index: 6, steps: 7 };
  assert.equal(listenStatusText(view), "Word 1 complete. Now let's learn Word 2…");
  assert.equal(listenStatusText({ ...view, state: 'loading', loadingTarget: { position: 2 } }), "Preparing Word 2 (the teacher's lesson and voice)…");
  for (const state of ['loading', 'playing', 'gap', 'paused', 'finished']) {
    assert.doesNotMatch(listenStatusText({ ...view, state }), /Finished this word|→ Next for the next word/);
  }
});

// ---------- regression: the player must never stop after a word ----------

// Audio driven clip by clip: each clip plays until the test "ends" it (its
// real 'ended' event). Ending an old clip again simulates a duplicate or stale
// 'ended' callback.
function clipAudio() {
  const clips = [];
  return {
    clips,
    played: () => clips.map((c) => c.text),
    playStep: (step) => new Promise((resolve) => { clips.push({ text: step.text, end: resolve }); }),
    stopAudio: () => {},
    last: () => clips.at(-1),
  };
}
const threeClipLessons = (total = 5) => (target) => {
  const position = target?.position ?? 1;
  return Promise.resolve({ position, review: false, total, next: position < total ? { position: position + 1, review: false } : null, steps: [1, 2, 3].map((i) => ({ kind: `k${i}`, text: `w${position}-${i}` })) });
};

test('REGRESSION: Word 1\'s final clip ends → Word 1 completed → Word 2 loaded and started automatically (no Next, no Play)', async () => {
  const audio = clipAudio();
  const completed = [];
  const loaded = [];
  const p = new ListenController({
    ...audio,
    loadLesson: async (t) => { const l = await threeClipLessons()(t); loaded.push(l.position); return l; },
    onComplete: (l) => completed.push(l.position),
    wait: () => Promise.resolve(),
  });
  p.open(undefined); // the one click on Listen & Learn
  await settle();
  assert.deepEqual(audio.played(), ['w1-1']);
  audio.last().end(); await settle(); // clip 1 ended → clip 2
  audio.last().end(); await settle(); // clip 2 ended → clip 3
  assert.deepEqual(audio.played(), ['w1-1', 'w1-2', 'w1-3']);
  assert.deepEqual(completed, [], 'not complete before the FINAL clip ends');
  audio.last().end(); await settle(); // the final clip ended
  assert.deepEqual(completed, [1], 'Word 1 completed on the final ended');
  assert.ok(loaded.includes(2), 'Word 2 lesson loaded');
  assert.equal(p.view.position, 2);
  assert.equal(p.state, 'playing');
  assert.deepEqual(audio.played(), ['w1-1', 'w1-2', 'w1-3', 'w2-1'], 'Word 2 audio started by itself');
  // ... and on to Word 3 the same way.
  for (let i = 0; i < 3; i++) { audio.last().end(); await settle(); }
  assert.deepEqual(completed, [1, 2]);
  assert.equal(p.view.position, 3);
  assert.equal(audio.last().text, 'w3-1');
});

test('REGRESSION: a duplicate ended for Word 1\'s final clip completes Word 1 once and starts Word 2 once', async () => {
  const audio = clipAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: threeClipLessons(), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(undefined);
  await settle();
  for (let i = 0; i < 2; i++) { audio.last().end(); await settle(); }
  const final = audio.last();
  final.end(); final.end(); // fired twice
  await settle();
  final.end();
  await settle();
  assert.deepEqual(completed, [1], 'completed once');
  assert.equal(audio.played().filter((t) => t === 'w2-1').length, 1, 'Word 2 started once');
  assert.deepEqual(audio.played().slice(3), ['w2-1'], 'Word 2 is still on its first clip (nothing skipped)');
});

test('REGRESSION: a stale ended from Word 1 arriving after Next (Word 2 playing) is ignored: Word 2 is not skipped, Word 1 not completed', async () => {
  const audio = clipAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: threeClipLessons(), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(undefined);
  await settle();
  const old = audio.last(); // w1-1 still playing
  p.next();
  await settle();
  assert.equal(audio.last().text, 'w2-1');
  old.end(); // the old clip's ended arrives late
  await settle();
  assert.equal(p.view.position, 2);
  assert.equal(p.view.index, 0, 'still on Word 2\'s first clip');
  assert.deepEqual(audio.played(), ['w1-1', 'w2-1'], 'nothing extra played');
  assert.deepEqual(completed, [], 'the skipped Word 1 is not completed');
  for (let i = 0; i < 3; i++) { audio.last().end(); await settle(); }
  assert.deepEqual(completed, [2], 'Word 2 completes normally');
});

test('REGRESSION: Repeat restarts the word; a late ended from before the Repeat is ignored; after the replay it continues to Word 2 by itself', async () => {
  const audio = clipAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: threeClipLessons(), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(undefined);
  await settle();
  audio.last().end(); await settle();
  const before = audio.last(); // w1-2 playing
  p.repeat();
  await settle();
  assert.equal(audio.last().text, 'w1-1', 'from the beginning');
  before.end(); await settle(); // stale
  assert.equal(p.view.index, 0);
  assert.deepEqual(completed, []);
  for (let i = 0; i < 3; i++) { audio.last().end(); await settle(); }
  assert.deepEqual(completed, [1], 'completed once, after the replay');
  assert.equal(audio.last().text, 'w2-1', 'then Word 2 automatically');
});

test('REGRESSION: Pause mid-word does not advance; Resume replays the interrupted clip and continues; Exit mid-word completes nothing', async () => {
  const audio = clipAudio();
  const completed = [];
  const p = new ListenController({ ...audio, loadLesson: threeClipLessons(), onComplete: (l) => completed.push(l.position), wait: () => Promise.resolve() });
  p.open(undefined);
  await settle();
  audio.last().end(); await settle();
  const interrupted = audio.last(); // w1-2
  p.pause();
  interrupted.end(); // the audio layer ends the stopped clip: must not count
  await settle();
  assert.equal(p.state, 'paused');
  assert.deepEqual([p.view.position, p.view.index], [1, 1]);
  p.play();
  await settle();
  assert.equal(audio.last().text, 'w1-2', 'resumes the same clip');
  audio.last().end(); await settle();
  audio.last().end(); await settle();
  assert.deepEqual(completed, [1]);
  assert.equal(p.view.position, 2);
  const mid = audio.last();
  p.exit();
  mid.end(); await settle();
  assert.equal(p.state, 'idle');
  assert.deepEqual(completed, [1], 'Word 2 was not completed by Exit or a late ended');
});

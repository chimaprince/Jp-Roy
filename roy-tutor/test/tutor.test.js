import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, getProgress, getEntryProgress, activeCourse, entryAt } from '../src/db.js';
import { upsertCourse, importEntries, validateEntries, parseCsv } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';
import { detectIntent } from '../src/intents.js';
import { saidMandarin, saidEnglish } from '../src/match.js';

// Entry 1 is the real first JH Medics entry. Entries 2 and 3 are placeholders
// used only by these tests.
const FIXTURE = [
  { position: 1, english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: null, source_page: null },
  { position: 2, english: 'test term two', mandarin: '测试二', pinyin: 'cè shì èr', meaning: 'placeholder meaning two', source_page: '2' },
  { position: 3, english: 'test term three', mandarin: '测试三', pinyin: 'cè shì sān', meaning: 'placeholder meaning three', source_page: '3' },
];

function setup() {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  const r = importEntries(db, 'vol1', FIXTURE);
  assert.ok(r.ok, r.errors.join(', '));
  let clock = new Date('2026-09-27T10:00:00');
  const tutor = new Tutor({ db, now: () => clock });
  return { db, tutor, setClock: (d) => { clock = new Date(d); } };
}

const spoken = (r) => r.say.map((s) => s.text).join(' ');

async function finishWord(tutor, entry) {
  await tutor.message(entry.mandarin); // pronounce
  await tutor.message(entry.english); // recognize
  await tutor.message(`这是${entry.mandarin}。`); // sentence
  await tutor.message(`这是${entry.mandarin}`); // conversation turn 1
  return tutor.message(`${entry.mandarin}`); // conversation turn 2
}

test('first session starts at entry 1 and follows the lesson flow', async () => {
  const { db, tutor } = setup();
  const r = await tutor.start();
  const text = spoken(r);
  assert.match(text, /Welcome, Roy/);
  assert.match(text, /Word 1 of 3/);
  assert.match(text, /epidural/);
  assert.ok(r.say.some((s) => s.lang === 'zh' && s.text === '硬膜外'));
  assert.ok(r.say.some((s) => s.show === 'yìng mó wài'));
  assert.match(text, /meaning for this entry has not been loaded yet/);
  assert.equal(r.listen, 'zh-CN');
  assert.equal(r.stage, 'new');

  const rec = await tutor.message('硬膜外');
  assert.equal(rec.listen, 'en-US');
  assert.equal(rec.card.english, null, 'English is hidden while testing recognition');
  const sent = await tutor.message('epidural');
  assert.match(spoken(sent), /sentence/);
  const conv = await tutor.message('这是硬膜外。');
  assert.equal(conv.stage, 'conversation');
  assert.match(spoken(conv), /interpreter/i);
  await tutor.message('硬膜外');
  const done = await tutor.message('这是硬膜外');
  assert.match(spoken(done), /Word 1 complete/);
  assert.match(spoken(done), /Word 2 of 3/);

  const course = activeCourse(db);
  assert.equal(getProgress(db, 'roy', course.id).current_position, 2);
  const ep = getEntryProgress(db, 'roy', entryAt(db, course.id, 1).id);
  assert.equal(ep.completed, 1);
  assert.equal(ep.times_practiced, 1);
  assert.equal(ep.weak, 0);
});

test('a new day reviews yesterday before any new word', async () => {
  const { db, tutor, setClock } = setup();
  await tutor.start();
  await finishWord(tutor, FIXTURE[0]);
  tutor.end();

  setClock('2026-09-28T09:00:00');
  const r = await tutor.start();
  assert.match(spoken(r), /Welcome back, Roy\. Yesterday we studied epidural\./);
  assert.equal(r.stage, 'review');
  assert.match(spoken(r), /How do you say "epidural" in Mandarin\?/);
  assert.equal(r.card.mandarin, null, 'answer hidden during review');

  const wrong = await tutor.message('不知道');
  assert.match(spoken(wrong), /Not quite/);
  const wrong2 = await tutor.message('还是不知道');
  assert.match(spoken(wrong2), /correct answer/);
  assert.ok(wrong2.say.some((s) => s.text === '硬膜外'));
  const course = activeCourse(db);
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, course.id, 1).id).weak, 1);

  await tutor.message('硬膜外'); // repeat after me; the weak word comes round again
  const again = await tutor.message('硬膜外');
  assert.match(spoken(again), /right word/);
  assert.match(spoken(again), /Review complete/);
  assert.match(spoken(again), /Word 2 of 3/);
  assert.equal(getProgress(db, 'roy', course.id).review_required, 0);
});

test('"I forgot" gives a hint, then the answer', async () => {
  const { tutor, setClock } = setup();
  await tutor.start();
  await finishWord(tutor, FIXTURE[0]);
  tutor.end();
  setClock('2026-09-28T09:00:00');
  await tutor.start();
  const hint = await tutor.message('I forgot');
  assert.match(spoken(hint), /hint/i);
  assert.ok(hint.say.some((s) => s.text === '硬' && s.show === '硬 (yìng)'));
  const reveal = await tutor.message('I forgot');
  assert.ok(reveal.say.some((s) => s.text === '硬膜外'));
  assert.match(spoken(reveal), /Say it after me/);
});

test('"I don\'t understand" re-explains from the curriculum without inventing a meaning', async () => {
  const { tutor } = setup();
  await tutor.start();
  const r = await tutor.message("I don't understand");
  assert.match(spoken(r), /English term is epidural/);
  assert.match(spoken(r), /not been loaded yet/);
  assert.equal(r.listen, 'zh-CN');
});

test('a jump does not move the saved curriculum position', async () => {
  const { db, tutor } = setup();
  await tutor.start();
  const j = await tutor.message('jump to test term three');
  assert.match(spoken(j), /place in the curriculum stays at word 1/);
  assert.equal(j.card.position, 3);
  assert.equal(j.jump, true);
  const back = await finishWord(tutor, FIXTURE[2]);
  assert.match(spoken(back), /Back to the curriculum, word 1/);
  const course = activeCourse(db);
  assert.equal(getProgress(db, 'roy', course.id).current_position, 1);
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, course.id, 3).id).completed, 0);

  const j2 = await tutor.message('go to word 2');
  assert.equal(j2.card.position, 2);
  const cont = await tutor.message("Let's continue");
  assert.equal(cont.card.position, 1);
  assert.equal(getProgress(db, 'roy', course.id).current_position, 1);
});

test('jumping to a word outside the curriculum is refused', async () => {
  const { tutor } = setup();
  await tutor.start();
  const r = await tutor.message('teach me appendectomy');
  assert.match(spoken(r), /couldn't find "appendectomy"/);
  assert.equal(r.card.position, 1);
});

test('same-day return resumes the open session', async () => {
  const { tutor } = setup();
  await tutor.start();
  await tutor.message('硬膜外');
  const r = await tutor.start();
  assert.match(spoken(r), /pick up where we left off/);
  assert.equal(r.listen, 'en-US');
});

test('role-play role can be chosen by voice', async () => {
  const { tutor } = setup();
  await tutor.start();
  await tutor.message('I will be the nurse');
  await tutor.message('硬膜外');
  await tutor.message('epidural');
  const conv = await tutor.message('这是硬膜外。');
  assert.match(spoken(conv), /You are the nurse/);
  assert.equal(conv.role, 'Nurse');
});

test('AI sentence check and role-play are used when available', async () => {
  const { db } = setup();
  const calls = [];
  const ai = {
    enabled: true,
    async checkMeaning(args) { calls.push(['meaning', args.answer]); return { correct: true, feedback: [{ lang: 'en', text: 'Yes, that is it.' }] }; },
    async checkSentence(args) { calls.push(['sentence', args.sentence]); return { correct: true, feedback: [{ lang: 'en', text: 'Well said.' }], corrected_sentence: null }; },
    async rolePlay(args) {
      calls.push(['role', args.royText]);
      const turns = args.history.length / 2;
      return { lines: [{ lang: 'en', text: `Doctor line ${turns}` }], roy_used_term: true, finished: turns >= 2, history: [...args.history, { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }] };
    },
  };
  const tutor = new Tutor({ db, ai, now: () => new Date('2026-09-27T10:00:00') });
  await tutor.start();
  await tutor.message('硬膜外');
  const meaning = await tutor.message("it's the injection near the spine for pain relief");
  assert.match(spoken(meaning), /Yes, that is it/);
  const conv = await tutor.message('医生说硬膜外');
  assert.match(spoken(conv), /Well said/);
  assert.match(spoken(conv), /Doctor line 0/);
  await tutor.message('硬膜外');
  const done = await tutor.message('硬膜外');
  assert.match(spoken(done), /Word 1 complete/);
  assert.deepEqual(calls.map((c) => c[0]), ['meaning', 'sentence', 'role', 'role', 'role']);
});

test('end of session stores a summary', async () => {
  const { db, tutor } = setup();
  await tutor.start();
  await finishWord(tutor, FIXTURE[0]);
  const r = tutor.end();
  assert.match(spoken(r), /New words: epidural/);
  assert.equal(r.ended, true);
  const course = activeCourse(db);
  const row = db.prepare('SELECT summary FROM study_sessions WHERE id = ?').get(getProgress(db, 'roy', course.id).last_session);
  assert.match(row.summary, /epidural/);
});

test('curriculum import keeps source text exactly and rejects bad positions', () => {
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'c', title: 'T', volume: 1, status: 'active' });
  const odd = { position: 1, english: 'Epidural  ', mandarin: '硬膜外 ', pinyin: 'yìng mó wài', meaning: 'Source wording, kept as-is (teh typo too)', source_page: '1' };
  assert.ok(importEntries(db, 'c', [odd]).ok);
  const row = entryAt(db, 'c', 1);
  assert.equal(row.english, odd.english);
  assert.equal(row.mandarin, odd.mandarin);
  assert.equal(row.meaning, odd.meaning);

  assert.equal(validateEntries([{ ...odd, position: 2 }]).errors.length > 0, true, 'gap at 1');
  assert.equal(validateEntries([odd, { ...odd }]).errors.length > 0, true, 'duplicate position');
  assert.equal(validateEntries([{ ...odd, mandarin: '' }]).errors.length > 0, true, 'missing mandarin');
  const failed = importEntries(db, 'c', [{ ...odd, position: 5 }]);
  assert.equal(failed.ok, false);
  assert.equal(entryAt(db, 'c', 1).english, odd.english, 'failed import changed nothing');
});

test('re-import keeps entry ids so progress survives', () => {
  const { db, tutor } = setup();
  const before = entryAt(db, 'vol1', 1).id;
  getEntryProgress(db, 'roy', before);
  const r = importEntries(db, 'vol1', FIXTURE);
  assert.ok(r.ok);
  assert.equal(entryAt(db, 'vol1', 1).id, before);
  getEntryProgress(db, 'roy', entryAt(db, 'vol1', 3).id);
  assert.equal(importEntries(db, 'vol1', FIXTURE.slice(0, 2)).ok, false, 'removing an entry with progress is refused');
  assert.ok(entryAt(db, 'vol1', 3), 'the refused import changed nothing');
  assert.ok(tutor);
});

test('a staged Volume 2 is never the active course', () => {
  const { db } = setup();
  upsertCourse(db, { id: 'vol2', title: 'JH Medics Volume 2', volume: 2, status: 'staged', requires: 'vol1' });
  importEntries(db, 'vol2', [{ position: 1, english: 'x', mandarin: '二', pinyin: 'èr' }]);
  assert.equal(activeCourse(db).id, 'vol1');
});

test('CSV parsing handles quotes and commas', () => {
  const rows = parseCsv('position,english,mandarin,pinyin,meaning,source_page\n1,epidural,硬膜外,yìng mó wài,"a, b ""c""",4\n');
  assert.deepEqual(rows[0], { position: '1', english: 'epidural', mandarin: '硬膜外', pinyin: 'yìng mó wài', meaning: 'a, b "c"', source_page: '4' });
});

test('intent detection', () => {
  assert.equal(detectIntent("Let's continue").type, 'continue');
  assert.equal(detectIntent("I don't understand").type, 'dontUnderstand');
  assert.equal(detectIntent('I forgot').type, 'forgot');
  assert.equal(detectIntent('我忘了').type, 'forgot');
  assert.equal(detectIntent('stop').type, 'end');
  assert.equal(detectIntent('Stop the bleeding').type, 'answer');
  assert.deepEqual(detectIntent('jump to epidural'), { type: 'jump', target: 'epidural' });
  assert.deepEqual(detectIntent('you are the doctor'), { type: 'role', role: 'Interpreter' });
  assert.deepEqual(detectIntent("I'll be the patient"), { type: 'role', role: 'Patient' });
  assert.equal(detectIntent('硬膜外').type, 'answer');
});

test('answer matching accepts characters or pinyin', () => {
  const e = FIXTURE[0];
  assert.ok(saidMandarin('硬膜外。', e));
  assert.ok(saidMandarin('ying mo wai', e));
  assert.ok(!saidMandarin('硬膜', e));
  assert.ok(saidEnglish('It means epidural', e));
  assert.ok(!saidEnglish('spinal', e));
});

// ---------- voice evaluation ----------

const voice = (_said, alternatives = [], confidence = 0.9) => ({ source: 'voice', alternatives, confidence });

test('pronunciation: the recogniser hearing the term passes', async () => {
  const { tutor } = setup();
  const r0 = await tutor.start();
  assert.equal(r0.mode, 'pronunciation');
  const r = await tutor.message('硬膜外', voice('硬膜外'));
  assert.match(spoken(r), /Correct! I heard/);
  assert.equal(r.mode, 'answer');
  assert.equal(r.listen, 'en-US');
});

test('pronunciation: a near miss names the syllable to fix and repeats until right', async () => {
  const { db, tutor } = setup();
  await tutor.start();
  const r = await tutor.message('应膜外', voice('应膜外', ['英模外']));
  const text = spoken(r);
  assert.match(text, /I heard "应膜外"/);
  assert.match(text, /can't measure your tones directly/, 'says honestly what it can check');
  assert.ok(r.say.some((s) => s.text === '硬' && s.show === '硬 (yìng)'), 'points at the missing syllable');
  assert.equal(r.mode, 'pronunciation', 'asks again');

  await tutor.message('不对', voice('不对'));
  const third = await tutor.message('不对', voice('不对'));
  assert.match(spoken(third), /one syllable at a time/);
  assert.equal(third.mode, 'pronunciation', 'still on pronunciation, never skipped');
  const course = activeCourse(db);
  assert.equal(getEntryProgress(db, 'roy', entryAt(db, course.id, 1).id).completed, 0);

  const ok = await tutor.message('硬膜外', voice('硬膜外'));
  assert.match(spoken(ok), /Correct/);
  assert.equal(ok.mode, 'answer');
});

test('pronunciation: the term found only in the recogniser\'s other guesses counts as close', async () => {
  const { tutor } = setup();
  await tutor.start();
  const r = await tutor.message('硬摸外', voice('硬摸外', ['硬膜外']));
  assert.match(spoken(r), /Close/);
  assert.equal(r.mode, 'answer');
});

test('pronunciation: AI explains likely tone slips from what the recogniser heard', async () => {
  const { db } = setup();
  const ai = {
    enabled: true,
    async explainPronunciation({ check }) {
      assert.equal(check.heard, '应膜外');
      return { feedback: [{ lang: 'en', text: 'The recogniser heard yīng, first tone. You need yìng, fourth tone.' }] };
    },
  };
  const tutor = new Tutor({ db, ai, now: () => new Date('2026-09-27T10:00:00') });
  await tutor.start();
  const r = await tutor.message('应膜外', voice('应膜外'));
  assert.match(spoken(r), /fourth tone/);
});

test('meaning: a natural answer is accepted without exact wording', async () => {
  const { tutor } = setup();
  await tutor.start();
  await tutor.message('jump to word 2');
  await tutor.message('测试二', voice('测试二'));
  const r = await tutor.message('I think it is the placeholder for meaning number two', voice(''));
  assert.match(spoken(r), /Correct/);
  assert.match(spoken(r), /sentence/);
});

test('meaning: a wrong answer is explained and asked again until right', async () => {
  const { tutor } = setup();
  await tutor.start();
  await tutor.message('硬膜外', voice('硬膜外'));
  const wrong = await tutor.message('a broken arm', voice(''));
  assert.match(spoken(wrong), /You said "a broken arm"/);
  assert.equal(wrong.mode, 'answer');
  const wrong2 = await tutor.message('no idea', voice(''));
  assert.match(spoken(wrong2), /means "epidural"/);
  assert.match(spoken(wrong2), /in your own words/);
  const right = await tutor.message('epidural', voice(''));
  assert.match(spoken(right), /sentence/);
});

test('sentence and role-play repeat until the term is used', async () => {
  const { tutor } = setup();
  await tutor.start();
  await tutor.message('硬膜外', voice('硬膜外'));
  await tutor.message('epidural', voice(''));
  const s1 = await tutor.message('我很好', voice('我很好'));
  assert.match(spoken(s1), /needs to include/);
  const s2 = await tutor.message('我很好', voice('我很好'));
  assert.match(spoken(s2), /这是硬膜外/, 'gives an example after two misses');
  const conv = await tutor.message('医生说硬膜外', voice('医生说硬膜外'));
  assert.equal(conv.stage, 'conversation');
  const miss = await tutor.message('你好', voice('你好'));
  assert.match(spoken(miss), /Try that line again/);
  await tutor.message('硬膜外', voice('硬膜外'));
  const done = await tutor.message('这是硬膜外', voice('这是硬膜外'));
  assert.match(spoken(done), /Word 1 complete/);
});

// ---------- the real Volume 1 file ----------

test('JH Medics Volume 1 data file: 385 entries in source order', async () => {
  const fs = await import('node:fs');
  const vol1 = JSON.parse(fs.readFileSync(new URL('../data/jh-medics-vol1.json', import.meta.url), 'utf8'));
  const db = openDb(':memory:');
  upsertCourse(db, { id: 'jh-medics-vol1', title: 'JH Medics Volume 1', volume: 1, status: 'active' });
  const r = importEntries(db, 'jh-medics-vol1', vol1.entries);
  assert.ok(r.ok, r.errors.join(', '));
  assert.equal(r.count, 385);
  const first = [1, 2, 3, 4, 5].map((p) => entryAt(db, 'jh-medics-vol1', p));
  assert.deepEqual(first.map((e) => e.english), ['epidural', 'esophagus', 'excrement', 'eye specialist', 'fainting']);
  assert.deepEqual(first.map((e) => e.mandarin), ['硬膜外', '食道', '大便', '眼科医生', '晕倒']);
  assert.equal(first[0].pinyin, 'yìng mó wài');
  assert.equal(first[0].source_page, '1');
  assert.match(first[0].meaning, /^Injection of a substance into a person's spine/);
  const last = entryAt(db, 'jh-medics-vol1', 385);
  assert.equal(last.english, 'Neuropathy');
  assert.equal(last.mandarin, '神经病');
  assert.equal(entryAt(db, 'jh-medics-vol1', 11).english, 'Regular physical examintion', 'source spelling kept');
  assert.equal(entryAt(db, 'jh-medics-vol1', 161).pinyin, '', 'no pinyin invented');

  const tutor = new Tutor({ db, now: () => new Date('2026-09-27T10:00:00') });
  const start = await tutor.start();
  assert.match(spoken(start), /Word 1 of 385\./);
  assert.equal(start.status.total, 385);
});

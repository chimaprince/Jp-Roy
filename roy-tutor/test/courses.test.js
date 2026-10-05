// One permanent teacher, any course document. A document only supplies WHAT is
// learnt (items, order, course name); HOW Roy is taught (the Qwen teacher's
// prompt, the lesson writer's prompt and checks, the Listen & Learn lesson
// structure, Interactive Practice, review) is the same code for every course.
//
// These tests read documents with the generic reader, add a second course with
// the course command, and run the same pipeline on JH Medics Volume 1 and on a
// second course through the real server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readDocument, readDocx, splitMandarin, entriesFromLines } from '../src/documents.js';
import { LISTEN_WRITER_PROMPT } from '../src/listencontent.js';
import { SYSTEM_PROMPT } from '../src/teacher.js';
import { REQUIRED_STEPS } from '../src/listen.js';
import { startListenQwen, startTutorServer, cleanEnv } from './helpers.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const JH_DOCX = path.join(appDir, 'data', 'source', 'JH_MEDICS_TRAINING_MANDARIN11.docx');
const FIXTURES = path.join(appDir, 'test', 'fixtures');
const JH_JSON = JSON.parse(fs.readFileSync(path.join(appDir, 'data', 'jh-medics-vol1.json'), 'utf8')).entries;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roy-course-'));

const CLINIC_TXT = `Clinic Phrases (a second course document)
挂号 guà hào register (at the hospital): to sign in at the registration desk
发烧 fā shāo fever: a body temperature above normal
请把袖子卷起来。 qǐng bǎ xiù zi juǎn qǐ lái Please roll up your sleeve.
预约 make an appointment
`;

// A minimal .docx (stored zip) with the given document.xml body.
function makeDocx(bodyXml) {
  const files = [
    ['[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['word/document.xml', `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${bodyXml}</w:body></w:document>`],
  ];
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const nameBuf = Buffer.from(name);
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
const p = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const row = (...cells) => `<w:tr>${cells.map((c) => `<w:tc>${p(c)}</w:tc>`).join('')}</w:tr>`;

// ---------- reading any document ----------

test('the generic reader rebuilds JH Medics Volume 1 from its original Word file exactly (no JH-specific code)', async () => {
  const { entries, from } = await readDocument(JH_DOCX);
  assert.match(from, /Word table/);
  assert.equal(entries.length, 385);
  for (let i = 0; i < 385; i++) {
    for (const k of ['english', 'mandarin', 'pinyin', 'meaning']) {
      assert.equal(entries[i][k] ?? null, JH_JSON[i][k] ?? null, `entry ${i + 1} ${k}`);
    }
    assert.equal(entries[i].position, i + 1, 'document order');
  }
});

test('PDF: the same 385 JH Medics entries from a 22-page PDF table (wrapped cells, tight rows); a text-list PDF; a scanned PDF is refused, never guessed', async () => {
  const norm = (v) => String(v ?? '').replace(/\s+/g, ' ').replace(/\s*-\s*/g, '-').trim();
  const pdf = await readDocument(path.join(FIXTURES, 'jh-vol1-table.pdf'));
  assert.match(pdf.from, /^PDF table \(22 pages\)$/);
  assert.equal(pdf.entries.length, 385);
  for (let i = 0; i < 385; i++) {
    for (const k of ['english', 'mandarin', 'pinyin', 'meaning']) assert.equal(norm(pdf.entries[i][k]), norm(JH_JSON[i][k]), `PDF entry ${i + 1} ${k}`);
  }
  const small = await readDocument(path.join(FIXTURES, 'course-table.pdf'));
  assert.deepEqual(small.entries.map((e) => [e.mandarin, e.pinyin, e.english]), [['硬膜外', 'yìng mó wài', 'epidural'], ['食道', 'shí dào', 'esophagus'], ['血压', 'xuè yā', 'blood pressure'], ['挂号', 'guà hào', 'register (at the hospital)']], 'a title line above the table is not an item');
  const lines = await readDocument(path.join(FIXTURES, 'clinic-lines.pdf'));
  assert.match(lines.from, /^PDF text/);
  assert.deepEqual(lines.entries.map((e) => e.mandarin), ['挂号', '发烧', '请把袖子卷起来。', '预约']);
  await assert.rejects(readDocument(path.join(FIXTURES, 'scanned.pdf')), /no readable text: it looks like a scanned image\. It needs OCR .* Nothing was imported/);
});

test('documents of other shapes: text lines, CSV/TSV with or without headers, Word tables in any column order, Word paragraphs; bad files are refused clearly', async () => {
  const dir = tmp();
  const write = (name, text) => { const f = path.join(dir, name); fs.writeFileSync(f, text); return f; };
  const txt = (await readDocument(write('clinic.txt', CLINIC_TXT))).entries;
  assert.deepEqual(txt.map((e) => [e.mandarin, e.pinyin, e.english, e.meaning]), [
    ['挂号', 'guà hào', 'register (at the hospital)', 'to sign in at the registration desk'],
    ['发烧', 'fā shāo', 'fever', 'a body temperature above normal'],
    ['请把袖子卷起来。', 'qǐng bǎ xiù zi juǎn qǐ lái', 'Please roll up your sleeve.', null],
    ['预约', '', 'make an appointment', null],
  ], 'a title line without Chinese is not an item; a neutral-tone syllable stays in the pinyin; missing pinyin stays missing');
  const csv = (await readDocument(write('c.csv', 'Chinese,Pinyin,English,Meaning\n头痛,tóu tòng,headache,"pain in the head"\n恶心,ě xīn,nausea,\n'))).entries;
  assert.deepEqual(csv.map((e) => [e.mandarin, e.pinyin, e.english, e.meaning]), [['头痛', 'tóu tòng', 'headache', 'pain in the head'], ['恶心', 'ě xīn', 'nausea', null]]);
  const tsv = (await readDocument(write('c.tsv', 'headache\t头痛 tóu tòng\tpain in the head, often with stress\nnausea\t恶心 ě xīn\tthe feeling of wanting to vomit\n'))).entries;
  assert.deepEqual(tsv.map((e) => [e.mandarin, e.pinyin, e.english]), [['头痛', 'tóu tòng', 'headache'], ['恶心', 'ě xīn', 'nausea']], 'no header: columns found from the content');
  const table = (await readDocument(write('t.docx', makeDocx(`<w:tbl>${row('Mandarin', 'English', 'Meaning')}${row('血压 xuè yā', 'blood pressure', 'The pressure of the blood in the arteries')}${row('心跳 xīn tiào', 'heartbeat', 'The beating of the heart')}</w:tbl>`)))).entries;
  assert.deepEqual(table.map((e) => [e.position, e.mandarin, e.pinyin, e.english, e.meaning]), [
    [1, '血压', 'xuè yā', 'blood pressure', 'The pressure of the blood in the arteries'],
    [2, '心跳', 'xīn tiào', 'heartbeat', 'The beating of the heart'],
  ]);
  const paras = (await readDocument(write('d.docx', makeDocx(p('Dialogue course') + p('您哪里不舒服？ nín nǎ lǐ bù shū fu What is bothering you?') + p('我头疼。 wǒ tóu téng I have a headache.'))))).entries;
  assert.deepEqual(paras.map((e) => [e.mandarin, e.english]), [['您哪里不舒服？', 'What is bothering you?'], ['我头疼。', 'I have a headache.']], 'a dialogue document: one sentence per item');
  const json = (await readDocument(write('j.json', JSON.stringify({ entries: [{ mandarin: '咳嗽', pinyin: 'ké sou', english: 'cough' }] })))).entries;
  assert.deepEqual(json.map((e) => [e.position, e.mandarin]), [[1, '咳嗽']]);
  await assert.rejects(readDocument(write('x.pdf', 'not really a pdf')), /not a readable PDF/);
  await assert.rejects(readDocument(write('empty.txt', '')), /empty/);
  await assert.rejects(readDocument(write('none.txt', 'A title\nonly English here\n')), /No items with Chinese were found/);
  await assert.rejects(readDocument(write('x.exe', 'MZ')), /Unsupported file type \.exe/);
  await assert.rejects(readDocument(write('bad.docx', 'not a zip')), /Word file could not be read/);
  await assert.rejects(readDocument(write('bad.json', '{oops')), /not valid JSON/);
  assert.deepEqual(splitMandarin('乳房x光片 rǔ fáng x guāng piàn'), { mandarin: '乳房x光片', pinyin: 'rǔ fáng x guāng piàn' });
  assert.deepEqual(entriesFromLines(['no Chinese here', '']), []);
  assert.deepEqual(entriesFromLines(['发烧 fā shāo fever']).map((e) => [e.pinyin, e.english]), [['fā shāo', 'fever']], 'an English word is not taken for pinyin');
  assert.equal(readDocx(makeDocx(p('a'))).tables.length, 0);
});

// ---------- the course command ----------

function courseCmd(env, ...args) {
  return execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/course.mjs', ...args], { cwd: appDir, env: { ...cleanEnv(), ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
// A fresh install: the repository's built-in courses, an empty database next
// to which added courses are kept.
function freshInstall() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'clinic.txt'), CLINIC_TXT);
  return { dir, env: { TUTOR_DB: path.join(dir, 'tutor.db') }, doc: path.join(dir, 'clinic.txt') };
}

test('course command: a new document becomes a waiting course kept next to the database (never in the code folder); activate switches; list shows both with their own place', () => {
  const d = freshInstall();
  const out = courseCmd(d.env, 'add', d.doc, '--title', 'Clinic Phrases');
  assert.match(out, /clinic\.txt \(text\): 4 items, in the document's order/);
  assert.match(out, /without pinyin: 1/);
  assert.match(out, /Added "Clinic Phrases" \(clinic-phrases\) as a waiting course/);
  assert.ok(fs.existsSync(path.join(d.dir, 'courses', 'clinic-phrases.json')), 'stored next to the database');
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.dir, 'courses', 'clinic-phrases.json'), 'utf8')).entries[2].mandarin, '请把袖子卷起来。', 'stored as written');
  assert.ok(!fs.existsSync(path.join(appDir, 'data', 'clinic-phrases.json')), 'the code folder is not touched');
  let list = courseCmd(d.env, 'list');
  assert.match(list, /\* ACTIVE +jh-medics-vol1 +JH Medics Volume 1 · item 1 of 385/, 'JH Medics stays the active (default) course');
  assert.match(list, /waiting +clinic-phrases +Clinic Phrases · item 1 of 4 \(added\)/);
  assert.match(courseCmd(d.env, 'add', d.doc, '--title', 'Clinic Phrases'), /Added "Clinic Phrases" \(clinic-phrases-2\)/, 'the same name again gets its own id');
  assert.throws(() => courseCmd(d.env, 'add', path.join(d.dir, 'none.pdf'), '--title', 'X'), /file not found/);
  assert.throws(() => courseCmd(d.env, 'activate', 'nope'), /There is no course "nope"/);
  assert.match(courseCmd(d.env, 'activate', 'clinic-phrases'), /"Clinic Phrases" is now the active course \(item 1 of 4\)/);
  list = courseCmd(d.env, 'list');
  assert.match(list, /waiting +jh-medics-vol1/);
  assert.match(list, /\* ACTIVE +clinic-phrases /);
});

// ---------- courses in the running app ----------

test('server: switching course answers with the new course, its own place and its current item at once; each course keeps its own place; upload adds a course; bad uploads are refused', async () => {
  const d = freshInstall();
  const q = await startListenQwen();
  const s = await startTutorServer(q.port, d.env);
  const post = (p2, body) => fetch(`${s.url}${p2}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });
  const upload = (name, buf, headers = {}) => fetch(`${s.url}/api/courses/upload`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name), ...headers }, body: buf });
  try {
    assert.match(s.output(), /Active course: JH Medics Volume 1 \(385 items\), Roy's place: item 1/);
    assert.match(s.output(), /Summary: version \S+ .*course JH Medics Volume 1 · AI Qwen \S+ · ASR qwen-audio-3\.1-asr-flash · TTS qwen3-tts-instruct-flash \(voice Cherry\)/);
    // JH Medics: hear items 1 and 2.
    for (const position of [1, 2]) assert.equal((await post('/api/listen/complete', { position })).status, 200);
    // Upload a second course (PDF), waiting.
    const up = await upload('Clinic Phrases.pdf', fs.readFileSync(path.join(FIXTURES, 'course-table.pdf')), { 'X-Course-Title': encodeURIComponent('Clinic <b>Phrases</b>') });
    assert.equal(up.status, 200);
    const added = await up.json();
    assert.equal(added.course.title, 'Clinic b Phrases /b', 'the title is cleaned: no markup');
    assert.equal(added.course.active, false, 'a new course waits; JH Medics stays active');
    assert.equal(added.report.items, 4);
    assert.match(added.report.from, /^PDF table/);
    assert.equal((await (await fetch(`${s.url}/api/status`)).json()).course.title, 'JH Medics Volume 1');
    // Switch: everything for the new course in the same answer.
    const sw = await (await post('/api/courses/active', { id: added.course.id })).json();
    assert.equal(sw.status.course.title, 'Clinic b Phrases /b');
    assert.equal(sw.status.position, 1);
    assert.equal(sw.status.total, 4);
    assert.equal(sw.card.mandarin, '硬膜外', "the new course's item 1, at once");
    assert.equal(sw.courses.find((c) => c.active).id, added.course.id);
    assert.equal((await post('/api/listen/complete', { position: 1 })).status, 200);
    // Back to JH Medics: its own place (item 3) is kept; the other course keeps item 2.
    const back = await (await post('/api/courses/active', { id: 'jh-medics-vol1' })).json();
    assert.deepEqual([back.status.course.title, back.status.position, back.card.mandarin], ['JH Medics Volume 1', 3, '大便']);
    assert.deepEqual(back.courses.map((c) => [c.id, c.position, c.active]), [['jh-medics-vol1', 3, true], [added.course.id, 2, false]]);
    // Refusals: scanned PDF, wrong type, too large, empty, unknown course.
    const scanned = await upload('scan.pdf', fs.readFileSync(path.join(FIXTURES, 'scanned.pdf')));
    assert.equal(scanned.status, 422);
    assert.match((await scanned.json()).error, /no readable text: it looks like a scanned image/);
    assert.equal((await upload('tool.exe', Buffer.from('MZ'))).status, 415);
    assert.equal((await upload('big.txt', Buffer.alloc(16 * 1024 * 1024, 0x41))).status, 413);
    assert.equal((await upload('empty.txt', Buffer.alloc(0))).status, 422);
    assert.equal((await post('/api/courses/active', { id: '../../etc/passwd' })).status, 404);
    assert.equal((await (await fetch(`${s.url}/api/courses`)).json()).courses.length, 2, 'refused uploads added nothing');
    // The server restarts with the same database: the choice and places persist.
    await s.stop();
    const again = await startTutorServer(q.port, d.env);
    try {
      const st = await (await fetch(`${again.url}/api/status`)).json();
      assert.deepEqual([st.course.title, st.position], ['JH Medics Volume 1', 3]);
      assert.equal((await (await fetch(`${again.url}/api/courses`)).json()).courses.length, 2, 'the added course is still there');
    } finally { await again.stop(); }
  } finally {
    await s.stop().catch(() => {});
    await q.close();
  }
});

test('server: the access code protects the course routes and the upload too', async () => {
  const d = freshInstall();
  const q = await startListenQwen();
  const s = await startTutorServer(q.port, { ...d.env, TUTOR_ACCESS_CODE: 'letmein' });
  try {
    assert.equal((await fetch(`${s.url}/api/courses`)).status, 401);
    assert.equal((await fetch(`${s.url}/api/courses/active`, { method: 'POST', body: '{"id":"x"}' })).status, 401);
    assert.equal((await fetch(`${s.url}/api/courses/upload`, { method: 'POST', headers: { 'X-File-Name': 'a.txt' }, body: '挂号 guà hào register' })).status, 401);
    assert.equal((await fetch(`${s.url}/api/courses`, { headers: { 'X-Access-Code': 'letmein' } })).status, 200);
    assert.equal((await fetch(`${s.url}/api/version`)).status, 200, 'the version stays readable');
    const health = await fetch(`${s.url}/health`);
    assert.equal(health.status, 200, 'the host health check needs no access code');
    assert.deepEqual(Object.keys(await health.json()).sort(), ['ok', 'version'], 'health says nothing else');
  } finally {
    await s.stop();
    await q.close();
  }
});

// ---------- the same teacher for both courses, through the real server ----------

async function runCourse({ activate }) {
  const d = freshInstall();
  courseCmd(d.env, 'add', d.doc, '--title', 'Clinic Phrases');
  if (activate) courseCmd(d.env, 'activate', activate);
  const q = await startListenQwen({ interactive: { asrText: '挂号' } });
  const s = await startTutorServer(q.port, d.env);
  try {
    const status = await (await fetch(`${s.url}/api/status`)).json();
    const one = await (await fetch(`${s.url}/api/listen`)).json();
    const three = await (await fetch(`${s.url}/api/listen?position=3`)).json();
    const start = await (await fetch(`${s.url}/api/session/start`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    return { status, one, three, start, seen: q.seen };
  } finally {
    await s.stop();
    await q.close();
  }
}

test('ONE teacher for every course: JH Medics and a second document go through the same prompts, the same lesson structure and the same Interactive Practice', async () => {
  const jh = await runCourse({ activate: null });
  const clinic = await runCourse({ activate: 'clinic-phrases' });

  // What changes: the course, its items, its order.
  assert.equal(jh.status.course.title, 'JH Medics Volume 1');
  assert.equal(clinic.status.course.title, 'Clinic Phrases');
  assert.equal(jh.status.total, 385);
  assert.equal(clinic.status.total, 4);
  assert.equal(jh.one.card.mandarin, '硬膜外');
  assert.equal(clinic.one.card.mandarin, '挂号', 'the second course starts at its own item 1');
  assert.equal(clinic.one.course.title, 'Clinic Phrases');

  // What does not change: the teacher.
  const writerSystem = (r) => [...new Set(r.seen.writerRequests.map((w) => w.system))];
  assert.deepEqual(writerSystem(jh), [LISTEN_WRITER_PROMPT]);
  assert.deepEqual(writerSystem(clinic), [LISTEN_WRITER_PROMPT], 'the same lesson writer for both courses');
  const teacherSystem = (r) => [...new Set(r.seen.teacherSystem)];
  assert.equal(teacherSystem(jh).length, 1);
  assert.ok(teacherSystem(jh)[0].startsWith(SYSTEM_PROMPT));
  assert.deepEqual(teacherSystem(clinic), teacherSystem(jh), 'the identical Interactive Practice teacher (system message) for both courses');
  const facts = clinic.seen.writerRequests.find((w) => w.facts.mandarin === '挂号').facts;
  assert.deepEqual([facts.course, facts.position, facts.pinyin, facts.english, facts.meaning_from_the_document], ['Clinic Phrases', 1, 'guà hào', 'register (at the hospital)', 'to sign in at the registration desk'], 'the writer is anchored to the document item');
  for (const r of [jh, clinic]) {
    for (const k of REQUIRED_STEPS) assert.ok(r.one.steps.some((st) => st.kind === k), `${r.status.course.title}: lesson has ${k}`);
    assert.equal(r.one.teaching.source, 'teacher', 'teaching material generated by the teacher (the documents have no examples)');
    assert.ok(r.one.teaching.explanation_en && r.one.teaching.usage_en && r.one.teaching.sentence_zh.includes(r.one.card.mandarin) && r.one.teaching.sentence_en && r.one.teaching.context_en);
  }
  // A sentence item from the document is taught the same way, introduced as a phrase.
  assert.equal(clinic.three.card.mandarin, '请把袖子卷起来。');
  assert.equal(clinic.three.steps[0].text, '我们来学一句医学用语：请把袖子卷起来。');
  assert.equal(clinic.one.steps[0].text, '我们来学一个医学词语：挂号。');
  // Interactive Practice teaches the active course's item.
  const startCtx = (r) => r.seen.teacher.find((c) => c.event === 'session_start');
  assert.equal(startCtx(jh).current_entry.mandarin, '硬膜外');
  assert.equal(startCtx(clinic).current_entry.mandarin, '挂号');
  assert.equal(startCtx(clinic).course.title, 'Clinic Phrases');
  assert.equal(clinic.start.status.position, 1);
});

test('the teacher code has no course-specific logic (JH Medics is only data)', () => {
  for (const file of ['src/teacher.js', 'src/tutor.js', 'src/listen.js', 'src/listencontent.js', 'src/voice.js', 'server.js', 'public/app.js', 'public/voice-core.js', 'public/index.html']) {
    const code = fs.readFileSync(path.join(appDir, file), 'utf8');
    const mentions = code.split('\n').filter((l) => /JH Medics|jh-medics/i.test(l) && !/for example JH Medics|JH Medics Volume 1 or any other|EVERY course: JH|\/\/ .*JH Medics Volume 1/.test(l));
    assert.deepEqual(mentions, [], `${file} mentions JH Medics outside examples/comments`);
  }
});

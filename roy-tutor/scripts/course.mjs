// Hand the teacher a new course document, see the courses, switch course.
// The teaching is the same for every course; a document only supplies what is
// learnt and its order.
//
//   npm run course -- list
//   npm run course -- add <file.docx|.txt|.csv|.tsv|.json> --title "Course name" [--id my-course] [--activate]
//   npm run course -- activate <course-id>
//
// `add` reads the document (see src/documents.js), shows what it found, saves
// it as data/<id>.json, lists it in data/courses.json and loads it. A new
// course is "staged" (waiting) unless --activate is given: the course you are
// studying is never switched without asking. `activate` makes one course the
// active one (the others keep their progress). Restart the tutor afterwards.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { importEntries, upsertCourse, validateEntries } from '../src/curriculum.js';
import { readDocument } from '../src/documents.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..');
const dataDir = path.resolve(process.env.TUTOR_DATA_DIR || path.join(appDir, 'data'));
const configFile = path.join(dataDir, 'courses.json');
const [command, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(name);
const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };

const readConfig = () => JSON.parse(fs.readFileSync(configFile, 'utf8'));
const writeConfig = (c) => fs.writeFileSync(configFile, `${JSON.stringify(c, null, 2)}\n`);
const db = openDb(process.env.TUTOR_DB || path.join(appDir, 'tutor.db'));

function setActive(config, id) {
  for (const c of config.courses) c.status = c.id === id ? 'active' : 'staged';
  writeConfig(config);
  for (const c of config.courses) upsertCourse(db, c);
}

if (command === 'list' || !command) {
  const config = readConfig();
  for (const c of config.courses) {
    let total = 0;
    try { const f = JSON.parse(fs.readFileSync(path.join(dataDir, c.file), 'utf8')); total = (f.entries ?? f).length; } catch { /* listed but file missing */ }
    const p = db.prepare('SELECT current_position AS pos FROM user_progress WHERE course_id = ?').get(c.id);
    console.log(`${c.status === 'active' ? '* ACTIVE ' : '  staged '} ${c.id.padEnd(24)} ${c.title} · ${total} items${p ? ` · at item ${Math.min(p.pos, total)}` : ''}`);
  }
  process.exit(0);
}

if (command === 'add') {
  const file = args.find((a, i) => !a.startsWith('--') && !['--title', '--id'].includes(args[i - 1]));
  const title = flag('--title');
  if (!file || !title) fail('usage: npm run course -- add <file> --title "Course name" [--id my-course] [--activate]');
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);
  const id = flag('--id') || title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'course';
  let read;
  try { read = readDocument(file); } catch (err) { fail(err.message); }
  const { errors, warnings, entries } = validateEntries(read.entries);
  if (!entries.length) fail('no items with Chinese were found in that document');
  if (errors.length) { errors.forEach((e) => console.error(`  error: ${e}`)); fail('the document could not be turned into a course; nothing was changed'); }

  console.log(`${path.basename(file)} (${read.from}): ${entries.length} items, in the document's order`);
  for (const e of entries.slice(0, 3)) console.log(`  ${e.position}. ${e.mandarin}${e.pinyin ? `  ${e.pinyin}` : ''}${e.english ? `  ${e.english}` : ''}${e.meaning ? `  (${e.meaning.slice(0, 60)}${e.meaning.length > 60 ? '…' : ''})` : ''}`);
  if (entries.length > 3) console.log('  …');
  const missing = (k) => entries.filter((e) => !e[k]).length;
  console.log(`  without pinyin: ${missing('pinyin')} · without English: ${missing('english')} · without a meaning: ${missing('meaning')} (the teacher still teaches them; nothing is invented into the course itself)`);

  const config = readConfig();
  if (config.courses.some((c) => c.id === id) && !has('--replace')) fail(`a course "${id}" already exists; choose another --id (or --replace it)`);
  const volume = Math.max(0, ...config.courses.map((c) => Number(c.volume) || 0)) + 1;
  const course = { id, title, volume, status: 'staged', file: `${id}.json` };
  fs.writeFileSync(path.join(dataDir, course.file), `${JSON.stringify({ course: { id, title, volume }, source_document: path.basename(file), entries: read.entries.map((e, i) => ({ ...e, position: i + 1 })) }, null, 2)}\n`);
  config.courses = config.courses.filter((c) => c.id !== id).concat(course);
  writeConfig(config);
  upsertCourse(db, course);
  const result = importEntries(db, id, read.entries.map((e, i) => ({ ...e, position: i + 1 })));
  if (!result.ok) fail(result.errors.join('; '));
  if (has('--activate')) {
    setActive(config, id);
    console.log(`Added and activated "${title}". Restart the tutor: lessons now come from this course (same teacher, same Listen & Learn and Interactive Practice).`);
  } else {
    console.log(`Added "${title}" as a waiting course. When you are ready: npm run course -- activate ${id}`);
  }
  process.exit(0);
}

if (command === 'activate') {
  const id = args[0];
  const config = readConfig();
  if (!config.courses.some((c) => c.id === id)) fail(`no course "${id}". See: npm run course -- list`);
  setActive(config, id);
  console.log(`"${config.courses.find((c) => c.id === id).title}" is now the active course. Restart the tutor. Other courses keep their progress.`);
  process.exit(0);
}

fail(`unknown command "${command}". Use: list, add, activate`);

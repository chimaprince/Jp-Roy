// Courses from the command line (the page has the same: the Courses panel).
// The teaching is the same for every course; a document only supplies what is
// learnt and its order.
//
//   npm run course -- list
//   npm run course -- add <file.pdf|.docx|.txt|.csv|.tsv|.json> --title "Course name" [--activate]
//   npm run course -- activate <course-id>
//
// `add` reads the document, shows what it found, keeps it next to the
// database (<db folder>/courses/) and loads it. A new course waits until it is
// activated: the course being studied never changes by itself. Each course
// keeps its own place. Restart the tutor (or use the page) to see changes.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { createCatalog } from '../src/courses.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbFile = path.resolve(process.env.TUTOR_DB || path.join(appDir, 'tutor.db'));
const db = openDb(dbFile);
const catalog = createCatalog({
  db,
  builtinDir: path.resolve(process.env.TUTOR_DATA_DIR || path.join(appDir, 'data')),
  userDir: path.resolve(process.env.TUTOR_COURSES_DIR || path.join(path.dirname(dbFile), 'courses')),
  log: { log() {} },
});
const [command, ...args] = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const fail = (msg) => { console.error(`!! ${msg}`); process.exit(1); };

catalog.load();

if (!command || command === 'list') {
  for (const c of catalog.list()) console.log(`${c.active ? '* ACTIVE ' : '  waiting'} ${c.id.padEnd(26)} ${c.title} · item ${c.position} of ${c.items}${c.builtin ? '' : ' (added)'}`);
  process.exit(0);
}

if (command === 'add') {
  const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--title');
  const title = flag('--title');
  if (!file) fail('usage: npm run course -- add <file> --title "Course name" [--activate]');
  if (!fs.existsSync(file)) fail(`file not found: ${file}`);
  try {
    const { course, report } = await catalog.add({ name: path.basename(file), buffer: fs.readFileSync(file), title, activate: args.includes('--activate') });
    console.log(`${path.basename(file)} (${report.from}): ${report.items} items, in the document's order`);
    for (const e of report.first) console.log(`  ${e.position}. ${e.mandarin}${e.pinyin ? `  ${e.pinyin}` : ''}${e.english ? `  ${e.english}` : ''}`);
    console.log(`  without pinyin: ${report.withoutPinyin} · without English: ${report.withoutEnglish} · without a meaning: ${report.withoutMeaning} (the teacher still teaches them; nothing is invented into the course itself)`);
    console.log(course.active
      ? `Added and activated "${course.title}" (${course.id}).`
      : `Added "${course.title}" (${course.id}) as a waiting course. To study it: npm run course -- activate ${course.id}`);
  } catch (err) { fail(err.message); }
  process.exit(0);
}

if (command === 'activate') {
  try { const c = catalog.activate(args[0]); console.log(`"${c.title}" is now the active course (item ${c.position} of ${c.items}). Other courses keep their place.`); } catch (err) { fail(`${err.message} See: npm run course -- list`); }
  process.exit(0);
}

fail(`unknown command "${command}". Use: list, add, activate`);

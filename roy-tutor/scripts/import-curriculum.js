// Usage:
//   npm run import                               load every course in data/courses.json
//   npm run import -- --file x.csv --course id   load one file into an existing course
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/db.js';
import { loadConfiguredCourses, loadEntriesFile, importEntries } from '../src/curriculum.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

const db = openDb();
const results = arg('--file')
  ? [{ course: arg('--course'), ...importEntries(db, arg('--course'), loadEntriesFile(arg('--file')).entries) }]
  : loadConfiguredCourses(db, dataDir);

let failed = false;
for (const r of results) {
  if (r.ok) console.log(`${r.course}: imported ${r.count} entries`);
  else { failed = true; console.error(`${r.course}: import stopped, nothing changed`); r.errors.forEach((e) => console.error(`  error: ${e}`)); }
  r.warnings.forEach((w) => console.warn(`  note: ${w}`));
}
process.exit(failed ? 1 : 0);

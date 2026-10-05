// The course catalog: which course documents Roy has, which one he is
// studying, and adding a new one. Every course is taught by the same teacher;
// a course only supplies its items and their order.
//
//   built-in courses   listed in data/courses.json (JH Medics Volume 1)
//   added courses      documents Roy adds (page upload or `npm run course`),
//                      kept next to the database in <db folder>/courses/, so
//                      updating the code never touches them
//   active course      stored in the database (courses.status); one at a time.
//                      Each course keeps its own place, sessions and review.
import fs from 'node:fs';
import path from 'node:path';
import { importEntries, validateEntries, loadEntriesFile } from './curriculum.js';
import { readDocumentBuffer } from './documents.js';

const MAX_TITLE = 80;

// A course title as shown to Roy: printable text only, at most 80 characters.
export function cleanTitle(title) {
  return String(title ?? '').normalize('NFC').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

// A safe course id (also its file name): lowercase letters, digits, dashes.
export function courseId(title) {
  return String(title).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'course';
}

// Adds a course row; an existing course keeps its status (Roy's choice).
function ensureCourse(db, c, status) {
  db.prepare(`INSERT INTO courses (id, title, volume, status, requires) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, volume = excluded.volume`).run(c.id, c.title, c.volume, status);
}

export function createCatalog({ db, builtinDir, userDir, log = console }) {
  const userIndex = path.join(userDir, 'courses.json');
  const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
  const builtin = () => readJson(path.join(builtinDir, 'courses.json'), { courses: [] }).courses;
  const added = () => readJson(userIndex, { courses: [] }).courses;
  const fileOf = (c, isBuiltin) => path.join(isBuiltin ? builtinDir : userDir, path.basename(c.file));

  function setActive(id) {
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE courses SET status = 'staged' WHERE status = 'active' AND id != ?").run(id);
      db.prepare("UPDATE courses SET status = 'active' WHERE id = ?").run(id);
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
  }

  return {
    // Loads every course (built-in, then added). Returns one result per course.
    load() {
      const results = [];
      for (const [list, isBuiltin] of [[builtin(), true], [added(), false]]) {
        for (const c of list) {
          ensureCourse(db, c, isBuiltin ? (c.status === 'active' ? 'active' : 'staged') : 'staged');
          let entries;
          try { entries = loadEntriesFile(fileOf(c, isBuiltin)).entries; } catch (err) { results.push({ course: c.id, ok: false, errors: [err.message], warnings: [] }); continue; }
          results.push({ course: c.id, builtin: isBuiltin, ...importEntries(db, c.id, entries) });
        }
      }
      // Exactly one active course: the database keeps Roy's choice; on a new
      // database, the built-in course marked active (JH Medics Volume 1).
      const active = db.prepare("SELECT id FROM courses WHERE status = 'active' ORDER BY volume").all();
      if (active.length !== 1) {
        const pick = active[0]?.id ?? builtin().find((c) => c.status === 'active')?.id ?? builtin()[0]?.id ?? added()[0]?.id;
        if (pick) setActive(pick);
      }
      return results;
    },

    list() {
      const rows = db.prepare('SELECT id, title, volume, status FROM courses ORDER BY volume').all();
      const known = new Set([...builtin().map((c) => c.id), ...added().map((c) => c.id)]);
      return rows.filter((r) => known.has(r.id)).map((r) => {
        const total = db.prepare('SELECT COUNT(*) AS n FROM curriculum WHERE course_id = ?').get(r.id).n;
        const p = db.prepare('SELECT current_position AS pos FROM user_progress WHERE course_id = ? ORDER BY current_position DESC LIMIT 1').get(r.id);
        const completed = db.prepare('SELECT COUNT(*) AS n FROM entry_progress ep JOIN curriculum c ON c.id = ep.entry_id WHERE c.course_id = ? AND ep.completed = 1').get(r.id).n;
        return { id: r.id, title: r.title, items: total, position: Math.min(p?.pos ?? 1, total), completed, finished: (p?.pos ?? 1) > total, active: r.status === 'active', builtin: builtin().some((c) => c.id === r.id) };
      });
    },

    activate(id) {
      if (!this.list().some((c) => c.id === id)) throw Object.assign(new Error(`There is no course "${id}".`), { status: 404 });
      setActive(id);
      return this.list().find((c) => c.id === id);
    },

    // A document → a new course (waiting unless activate is true).
    async add({ name, buffer, title, activate = false }) {
      const cleanName = path.basename(String(name ?? ''));
      const t = cleanTitle(title) || cleanTitle(cleanName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '));
      if (!t) throw Object.assign(new Error('Give the course a name.'), { status: 400 });
      const read = await readDocumentBuffer(cleanName, buffer).catch((err) => { throw Object.assign(err, { status: 422 }); });
      const entries = read.entries.map((e, i) => ({ ...e, position: i + 1 }));
      const { errors, entries: valid } = validateEntries(entries);
      if (errors.length) throw Object.assign(new Error(`The document could not be turned into a course: ${errors.slice(0, 3).join('; ')}`), { status: 422 });
      const ids = new Set([...builtin().map((c) => c.id), ...added().map((c) => c.id)]);
      let id = courseId(t);
      for (let n = 2; ids.has(id); n++) id = `${courseId(t)}-${n}`;
      const volume = Math.max(0, ...db.prepare('SELECT volume FROM courses').all().map((r) => r.volume)) + 1;
      const course = { id, title: t, volume, file: `${id}.json` };
      fs.mkdirSync(userDir, { recursive: true });
      fs.writeFileSync(path.join(userDir, course.file), `${JSON.stringify({ course: { id, title: t, volume }, source_document: cleanName, added: new Date().toISOString(), entries }, null, 2)}\n`);
      const index = readJson(userIndex, { courses: [] });
      index.courses.push(course);
      fs.writeFileSync(userIndex, `${JSON.stringify(index, null, 2)}\n`);
      ensureCourse(db, course, 'staged');
      const result = importEntries(db, id, entries);
      if (!result.ok) throw Object.assign(new Error(result.errors.join('; ')), { status: 422 });
      if (activate) setActive(id);
      const missing = (k) => valid.filter((e) => !e[k]).length;
      log.log?.(`[courses] added "${t}" (${id}): ${valid.length} items from ${cleanName} (${read.from})`);
      return {
        course: this.list().find((c) => c.id === id),
        report: { from: read.from, items: valid.length, withoutPinyin: missing('pinyin'), withoutEnglish: missing('english'), withoutMeaning: missing('meaning'), first: valid.slice(0, 3).map((e) => ({ position: e.position, mandarin: e.mandarin, pinyin: e.pinyin || null, english: e.english || null })) },
      };
    },
  };
}

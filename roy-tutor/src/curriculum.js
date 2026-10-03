import fs from 'node:fs';
import path from 'node:path';

const REQUIRED = ['english', 'mandarin'];

// Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines in quotes).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.replace(/^﻿/, '').trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

export function loadEntriesFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  if (path.extname(file).toLowerCase() === '.csv') {
    return { course: null, entries: parseCsv(text) };
  }
  const json = JSON.parse(text);
  return { course: json.course ?? null, entries: json.entries ?? [] };
}

// Checks the entries without changing them. Returns { errors, warnings, entries }.
export function validateEntries(rawEntries) {
  const errors = [];
  const warnings = [];
  const entries = rawEntries.map((e, i) => {
    const position = Number(e.position);
    if (!Number.isInteger(position) || position < 1) {
      errors.push(`row ${i + 1}: position "${e.position}" is not a whole number of 1 or more`);
    }
    for (const key of REQUIRED) {
      if (typeof e[key] !== 'string' || e[key] === '') errors.push(`position ${e.position}: missing ${key}`);
    }
    const blank = (v) => v === undefined || v === null || v === '';
    if (blank(e.pinyin)) warnings.push(`position ${e.position} (${e.english}): no pinyin in the source`);
    else if (typeof e.pinyin !== 'string') errors.push(`position ${e.position}: pinyin must be text`);
    if (blank(e.meaning)) warnings.push(`position ${e.position} (${e.english}): no meaning in the source`);
    return {
      position,
      english: e.english,
      mandarin: e.mandarin,
      pinyin: blank(e.pinyin) ? '' : e.pinyin,
      meaning: blank(e.meaning) ? null : String(e.meaning),
      source_page: blank(e.source_page) ? null : String(e.source_page),
    };
  });
  const sorted = [...entries].sort((a, b) => a.position - b.position);
  sorted.forEach((e, i) => {
    if (e.position !== i + 1) {
      errors.push(`positions must run 1..${entries.length} with no gaps or repeats (found ${e.position} where ${i + 1} was expected)`);
    }
  });
  return { errors: [...new Set(errors)], warnings, entries: sorted };
}

export function upsertCourse(db, course) {
  db.prepare(`
    INSERT INTO courses (id, title, volume, status, requires) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET title = excluded.title, volume = excluded.volume,
      status = excluded.status, requires = excluded.requires`)
    .run(course.id, course.title, course.volume, course.status ?? 'staged', course.requires ?? null);
}

// Writes the entries verbatim. Existing rows keep their id, so progress survives a re-import.
// Entries past the new last position are only removed if nobody has progress on them.
export function importEntries(db, courseId, rawEntries) {
  const { errors, warnings, entries } = validateEntries(rawEntries);
  if (errors.length) return { ok: false, errors, warnings };
  const upsert = db.prepare(`
    INSERT INTO curriculum (course_id, position, english, mandarin, pinyin, meaning, source_page)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(course_id, position) DO UPDATE SET english = excluded.english,
      mandarin = excluded.mandarin, pinyin = excluded.pinyin, meaning = excluded.meaning,
      source_page = excluded.source_page`);
  const stale = db.prepare(`
    SELECT c.id, c.position FROM curriculum c WHERE c.course_id = ? AND c.position > ?`);
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      upsert.run(courseId, e.position, e.english, e.mandarin, e.pinyin, e.meaning, e.source_page);
    }
    for (const row of stale.all(courseId, entries.length)) {
      const used = db.prepare('SELECT 1 FROM entry_progress WHERE entry_id = ?').get(row.id);
      if (used) throw new Error(`position ${row.position} is no longer in the file but has study progress; not removing it`);
      db.prepare('DELETE FROM curriculum WHERE id = ?').run(row.id);
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    return { ok: false, errors: [err.message], warnings };
  }
  return { ok: true, errors: [], warnings, count: entries.length };
}

// Loads every course listed in data/courses.json. Only courses listed there are touched.
export function loadConfiguredCourses(db, dataDir) {
  const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'courses.json'), 'utf8'));
  const results = [];
  for (const course of config.courses) {
    upsertCourse(db, course);
    const { entries } = loadEntriesFile(path.join(dataDir, course.file));
    results.push({ course: course.id, ...importEntries(db, course.id, entries) });
  }
  return results;
}

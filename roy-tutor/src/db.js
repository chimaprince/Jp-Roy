import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  volume      INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('active', 'staged', 'retired')),
  requires    TEXT REFERENCES courses(id)
);

-- One row per JH Medics entry. Text columns hold the source wording verbatim.
CREATE TABLE IF NOT EXISTS curriculum (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  course_id   TEXT NOT NULL REFERENCES courses(id),
  position    INTEGER NOT NULL,
  english     TEXT NOT NULL,
  mandarin    TEXT NOT NULL,
  pinyin      TEXT NOT NULL,
  meaning     TEXT,
  source_page TEXT,
  UNIQUE (course_id, position)
);

CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_progress (
  user_id          TEXT NOT NULL REFERENCES users(id),
  course_id        TEXT NOT NULL REFERENCES courses(id),
  current_position INTEGER NOT NULL DEFAULT 1,
  last_study_date  TEXT,
  last_session     INTEGER REFERENCES study_sessions(id),
  review_required  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, course_id)
);

CREATE TABLE IF NOT EXISTS entry_progress (
  user_id         TEXT NOT NULL REFERENCES users(id),
  entry_id        INTEGER NOT NULL REFERENCES curriculum(id),
  completed       INTEGER NOT NULL DEFAULT 0,
  times_practiced INTEGER NOT NULL DEFAULT 0,
  last_reviewed   TEXT,
  confidence      INTEGER NOT NULL DEFAULT 0,
  weak            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, entry_id)
);

CREATE TABLE IF NOT EXISTS study_sessions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL REFERENCES users(id),
  course_id     TEXT NOT NULL REFERENCES courses(id),
  study_date    TEXT NOT NULL,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  words_studied TEXT NOT NULL DEFAULT '[]',
  words_reviewed TEXT NOT NULL DEFAULT '[]',
  weak_words    TEXT NOT NULL DEFAULT '[]',
  summary       TEXT,
  state         TEXT NOT NULL DEFAULT '{}'
);

-- Listen & Learn: the teacher's example sentence and usage notes for an entry,
-- generated once by Qwen and kept (the curriculum itself is never changed).
CREATE TABLE IF NOT EXISTS listen_content (
  entry_id   INTEGER PRIMARY KEY REFERENCES curriculum(id),
  content    TEXT NOT NULL,
  model      TEXT,
  created_at TEXT NOT NULL
);

-- Listen & Learn: words whose whole lesson has finished playing. Separate from
-- entry_progress: listening never completes a word in Interactive Practice.
CREATE TABLE IF NOT EXISTS listen_progress (
  user_id     TEXT NOT NULL REFERENCES users(id),
  entry_id    INTEGER NOT NULL REFERENCES curriculum(id),
  times       INTEGER NOT NULL DEFAULT 0,
  finished_at TEXT NOT NULL,
  PRIMARY KEY (user_id, entry_id)
);
`;

export function openDb(file = process.env.TUTOR_DB || 'tutor.db') {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

export function ensureUser(db, id, name) {
  db.prepare('INSERT OR IGNORE INTO users (id, name) VALUES (?, ?)').run(id, name);
}

export function activeCourse(db) {
  return db.prepare("SELECT * FROM courses WHERE status = 'active' ORDER BY volume LIMIT 1").get() ?? null;
}

export function courseLength(db, courseId) {
  return db.prepare('SELECT COUNT(*) AS n FROM curriculum WHERE course_id = ?').get(courseId).n;
}

export function entryAt(db, courseId, position) {
  return db.prepare('SELECT * FROM curriculum WHERE course_id = ? AND position = ?').get(courseId, position) ?? null;
}

export function entryById(db, id) {
  return db.prepare('SELECT * FROM curriculum WHERE id = ?').get(id) ?? null;
}

export function allEntries(db, courseId) {
  return db.prepare('SELECT * FROM curriculum WHERE course_id = ? ORDER BY position').all(courseId);
}

export function getProgress(db, userId, courseId) {
  db.prepare('INSERT OR IGNORE INTO user_progress (user_id, course_id) VALUES (?, ?)').run(userId, courseId);
  return db.prepare('SELECT * FROM user_progress WHERE user_id = ? AND course_id = ?').get(userId, courseId);
}

export function updateProgress(db, userId, courseId, fields) {
  const cols = Object.keys(fields);
  if (!cols.length) return;
  const sql = `UPDATE user_progress SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ? AND course_id = ?`;
  db.prepare(sql).run(...cols.map((c) => fields[c]), userId, courseId);
}

export function getEntryProgress(db, userId, entryId) {
  db.prepare('INSERT OR IGNORE INTO entry_progress (user_id, entry_id) VALUES (?, ?)').run(userId, entryId);
  return db.prepare('SELECT * FROM entry_progress WHERE user_id = ? AND entry_id = ?').get(userId, entryId);
}

export function updateEntryProgress(db, userId, entryId, fields) {
  getEntryProgress(db, userId, entryId);
  const cols = Object.keys(fields);
  const sql = `UPDATE entry_progress SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ? AND entry_id = ?`;
  db.prepare(sql).run(...cols.map((c) => fields[c]), userId, entryId);
}

export function completedCount(db, userId, courseId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM entry_progress ep JOIN curriculum c ON c.id = ep.entry_id
    WHERE ep.user_id = ? AND c.course_id = ? AND ep.completed = 1`).get(userId, courseId).n;
}

export function weakEntries(db, userId, courseId, limit = 5) {
  return db.prepare(`
    SELECT c.* FROM entry_progress ep JOIN curriculum c ON c.id = ep.entry_id
    WHERE ep.user_id = ? AND c.course_id = ? AND ep.weak = 1
    ORDER BY ep.confidence ASC, c.position ASC LIMIT ?`).all(userId, courseId, limit);
}

export function getSession(db, id) {
  const row = db.prepare('SELECT * FROM study_sessions WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    words_studied: JSON.parse(row.words_studied),
    words_reviewed: JSON.parse(row.words_reviewed),
    weak_words: JSON.parse(row.weak_words),
    state: JSON.parse(row.state),
  };
}

export function createSession(db, userId, courseId, studyDate, now) {
  const r = db.prepare(`
    INSERT INTO study_sessions (user_id, course_id, study_date, started_at) VALUES (?, ?, ?, ?)`)
    .run(userId, courseId, studyDate, now);
  return getSession(db, Number(r.lastInsertRowid));
}

export function saveSession(db, session) {
  db.prepare(`
    UPDATE study_sessions SET ended_at = ?, words_studied = ?, words_reviewed = ?, weak_words = ?,
      summary = ?, state = ? WHERE id = ?`).run(
    session.ended_at ?? null,
    JSON.stringify(session.words_studied),
    JSON.stringify(session.words_reviewed),
    JSON.stringify(session.weak_words),
    session.summary ?? null,
    JSON.stringify(session.state),
    session.id,
  );
}

// The most recent session for this user/course that happened before `studyDate`
// and actually covered some words.
export function previousStudySession(db, userId, courseId, studyDate) {
  const row = db.prepare(`
    SELECT id FROM study_sessions
    WHERE user_id = ? AND course_id = ? AND study_date < ?
      AND (words_studied != '[]' OR words_reviewed != '[]')
    ORDER BY id DESC LIMIT 1`).get(userId, courseId, studyDate);
  return row ? getSession(db, row.id) : null;
}

export function openSessionForDate(db, userId, courseId, studyDate) {
  const row = db.prepare(`
    SELECT id FROM study_sessions WHERE user_id = ? AND course_id = ? AND study_date = ?
    ORDER BY id DESC LIMIT 1`).get(userId, courseId, studyDate);
  return row ? getSession(db, row.id) : null;
}

// ---------- Listen & Learn ----------

export function getListenContent(db, entryId) {
  const row = db.prepare('SELECT content FROM listen_content WHERE entry_id = ?').get(entryId);
  return row ? JSON.parse(row.content) : null;
}

export function saveListenContent(db, entryId, content, model, now = new Date().toISOString()) {
  db.prepare('INSERT OR REPLACE INTO listen_content (entry_id, content, model, created_at) VALUES (?, ?, ?, ?)').run(entryId, JSON.stringify(content), model ?? null, now);
}

export function markListened(db, userId, entryId, now = new Date().toISOString()) {
  db.prepare(`INSERT INTO listen_progress (user_id, entry_id, times, finished_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(user_id, entry_id) DO UPDATE SET times = times + 1, finished_at = excluded.finished_at`).run(userId, entryId, now);
}

// Where Listen & Learn continues: the first word, in curriculum order, whose
// lesson has not finished yet (a skipped word stays unfinished).
export function listenPosition(db, userId, courseId) {
  const row = db.prepare(`SELECT MIN(c.position) AS position FROM curriculum c
    LEFT JOIN listen_progress l ON l.entry_id = c.id AND l.user_id = ?
    WHERE c.course_id = ? AND l.entry_id IS NULL`).get(userId, courseId);
  return row?.position ?? null; // null: every word listened to
}

export function listenedCount(db, userId, courseId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM listen_progress l JOIN curriculum c ON c.id = l.entry_id
    WHERE l.user_id = ? AND c.course_id = ?`).get(userId, courseId).n;
}

export function wasListened(db, userId, entryId) {
  return Boolean(db.prepare('SELECT 1 FROM listen_progress WHERE user_id = ? AND entry_id = ?').get(userId, entryId));
}

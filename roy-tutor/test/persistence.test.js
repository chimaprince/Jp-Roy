import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, getProgress, getEntryProgress, entryAt, completedCount } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { Tutor } from '../src/tutor.js';

// Progress persistence and resume, on a real SQLite file with the real 385-entry
// JH Medics Volume 1 curriculum. Each "restart" closes the database and opens
// it again with a new Tutor, as a server restart does. The AI teacher is a
// stand-in returning fixed decisions: only the engine decides what is saved.

const VOL1 = JSON.parse(fs.readFileSync(new URL('../data/jh-medics-vol1.json', import.meta.url), 'utf8'));
const COURSE = VOL1.course.id;

function decision(over = {}) {
  return {
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'Teacher reply.', show: null, slow: false }], notes: '', ...over,
  };
}
const passed = () => decision({ correct: true, exercise_complete: true, next_action: 'next_exercise' });

function stubTeacher() {
  const queue = [];
  const contexts = [];
  return {
    configured: true,
    contexts,
    next(...ds) { queue.push(...ds); },
    async decide(ctx) { contexts.push(ctx); return queue.shift() ?? decision(); },
  };
}

// A database file on disk, loaded the way the server loads it.
function freshDbFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-tutor-'));
  const file = path.join(dir, 'tutor.db');
  const db = openDb(file);
  upsertCourse(db, { ...VOL1.course, status: 'active' });
  assert.ok(importEntries(db, COURSE, VOL1.entries).ok);
  db.close();
  return file;
}

function boot(file, clock) {
  const db = openDb(file);
  const teacher = stubTeacher();
  const tutor = new Tutor({ db, teacher, now: () => new Date(clock) });
  return { db, teacher, tutor };
}

// Read what is saved, from a separate connection.
function saved(file) {
  const db = openDb(file);
  const entryId = (p) => entryAt(db, COURSE, p).id;
  const out = {
    position: getProgress(db, 'roy', COURSE).current_position,
    completedCount: completedCount(db, 'roy', COURSE),
    word1: getEntryProgress(db, 'roy', entryId(1)),
    word2: getEntryProgress(db, 'roy', entryId(2)),
  };
  db.close();
  return out;
}

const DAY1 = '2026-09-28T10:00:00';
const DAY1_LATER = '2026-09-28T18:00:00';
const DAY2 = '2026-09-29T09:00:00';

// Word 1 through the normal flow: pronounce, meaning, sentence, role-play.
async function completeWord1(tutor, teacher) {
  teacher.next(passed(), passed(), passed(), passed());
  await tutor.message('硬膜外', { source: 'voice' });
  await tutor.message('An injection into the spine so the lower back stops feeling pain.', { source: 'voice' });
  await tutor.message('医生建议打硬膜外。', { source: 'voice' });
  return tutor.message('病人需要硬膜外。', { source: 'voice' });
}

test('the course starts at word 1 of 385: epidural', async () => {
  const file = freshDbFile();
  const { db, teacher, tutor } = boot(file, DAY1);
  const r = await tutor.start();
  assert.equal(r.card.position, 1);
  assert.equal(teacher.contexts.at(-1).current_entry.english, 'epidural');
  assert.equal(r.status.total, 385);
  db.close();
  assert.equal(saved(file).position, 1);
});

test('completed word persistence: word 1 is saved as completed only after all four exercises', async () => {
  const file = freshDbFile();
  const { db, teacher, tutor } = boot(file, DAY1);
  await tutor.start();

  // Introduced and pronounced: not complete.
  teacher.next(passed());
  await tutor.message('硬膜外', { source: 'voice' });
  assert.equal(saved(file).word1.completed, 0, 'pronouncing it does not complete it');
  // Meaning and sentence too: still not complete.
  teacher.next(passed(), passed());
  await tutor.message('An injection into the spine to stop pain.', { source: 'voice' });
  await tutor.message('医生建议打硬膜外。', { source: 'voice' });
  assert.equal(saved(file).word1.completed, 0, 'three of four exercises is not complete');
  assert.equal(saved(file).position, 1);

  // Role-play finishes it.
  teacher.next(passed());
  const r = await tutor.message('病人需要硬膜外。', { source: 'voice' });
  db.close();
  const s = saved(file);
  assert.equal(s.word1.completed, 1);
  assert.equal(s.word1.times_practiced, 1);
  assert.equal(s.completedCount, 1);
  assert.equal(s.word2.completed, 0, 'word 2 is not touched');
  assert.equal(r.card.position, 2, 'the lesson moves on to word 2');
});

test('current position persistence: the saved position becomes word 2', async () => {
  const file = freshDbFile();
  const { db, teacher, tutor } = boot(file, DAY1);
  await tutor.start();
  await completeWord1(tutor, teacher);
  db.close();
  assert.equal(saved(file).position, 2);
  const check = openDb(file);
  assert.equal(entryAt(check, COURSE, saved(file).position).english, 'esophagus');
  check.close();
});

test('resume from the next word after a server restart the same day', async () => {
  const file = freshDbFile();
  const first = boot(file, DAY1);
  await first.tutor.start();
  await completeWord1(first.tutor, first.teacher);
  first.db.close(); // server stops

  const second = boot(file, DAY1_LATER); // server starts again
  assert.equal(second.tutor.status().position, 2, 'status reports word 2 before any lesson starts');
  const r = await second.tutor.start();
  const ctx = second.teacher.contexts.at(-1);
  assert.equal(ctx.current_entry.position, 2);
  assert.equal(ctx.current_entry.english, 'esophagus');
  assert.equal(ctx.lesson_state.exercise, 'pronounce');
  assert.equal(r.card.position, 2);
  assert.equal(r.card.english, 'esophagus');
  second.db.close();
  assert.equal(saved(file).word1.completed, 1, 'word 1 stays completed');
});

test('resume from the next word after ending the session and starting a fresh one', async () => {
  const file = freshDbFile();
  const first = boot(file, DAY1);
  await first.tutor.start();
  await completeWord1(first.tutor, first.teacher);
  await first.tutor.end();
  first.db.close();

  const second = boot(file, DAY1_LATER);
  const r = await second.tutor.start();
  assert.equal(second.teacher.contexts.at(-1).event, 'session_start', 'a new session, not the ended one');
  assert.equal(r.card.position, 2);
  assert.equal(r.exercise, 'pronounce');
  second.db.close();
});

test('next day: review of word 1 comes first, then new material continues at word 2', async () => {
  const file = freshDbFile();
  const first = boot(file, DAY1);
  await first.tutor.start();
  await completeWord1(first.tutor, first.teacher);
  await first.tutor.end();
  first.db.close();

  const second = boot(file, DAY2);
  const r = await second.tutor.start();
  assert.equal(r.stage, 'review', 'yesterday\'s word is reviewed first');
  assert.equal(second.teacher.contexts.at(-1).current_entry.english, 'epidural');
  assert.equal(second.teacher.contexts.at(-1).if_complete.next_entry.english, 'esophagus', 'after review: word 2');
  second.teacher.next(passed());
  const next = await second.tutor.message('硬膜外', { source: 'voice' });
  assert.equal(next.stage, 'new');
  assert.equal(next.card.position, 2);
  second.db.close();
  const s = saved(file);
  assert.equal(s.position, 2, 'reviewing word 1 does not move the position back');
  assert.equal(s.word1.completed, 1);
});

test('stopping before completion and resuming continues the same word', async () => {
  const file = freshDbFile();
  const first = boot(file, DAY1);
  await first.tutor.start();
  first.teacher.next(passed(), passed()); // pronounce and meaning only
  await first.tutor.message('硬膜外', { source: 'voice' });
  await first.tutor.message('An injection into the spine to stop pain.', { source: 'voice' });
  first.db.close(); // stopped before completing word 1

  let s = saved(file);
  assert.equal(s.word1.completed, 0);
  assert.equal(s.position, 1);
  assert.equal(s.completedCount, 0);

  // Same day, server restarted: the open session resumes word 1 at the next exercise.
  const second = boot(file, DAY1_LATER);
  const r = await second.tutor.start();
  assert.equal(second.teacher.contexts.at(-1).event, 'session_resume');
  assert.equal(r.card.position, 1);
  assert.equal(r.exercise, 'sentence', 'the exercises already passed are kept');
  await second.tutor.end(); // Roy stops for today
  second.db.close();

  // Next day: still word 1, started again from the first exercise.
  const third = boot(file, DAY2);
  const again = await third.tutor.start();
  assert.equal(again.card.position, 1);
  assert.equal(third.teacher.contexts.at(-1).current_entry.english, 'epidural');
  assert.equal(again.exercise, 'pronounce');
  third.db.close();
  s = saved(file);
  assert.equal(s.word1.completed, 0, 'still not completed');
  assert.equal(s.position, 1);
});

test('"I don\'t know" or a premature "complete" from the teacher never completes a word', async () => {
  const file = freshDbFile();
  const { db, teacher, tutor } = boot(file, DAY1);
  await tutor.start();
  teacher.next(
    decision({ intent: 'uncertain', exercise_complete: true }),
    decision({ intent: 'continue', exercise_complete: true }),
    decision({ intent: 'answer', correct: false, exercise_complete: true }),
  );
  await tutor.message("I don't know this word.", { source: 'text' });
  await tutor.message("Let's continue.", { source: 'text' });
  const r = await tutor.message('硬膜', { source: 'voice' });
  assert.equal(r.exercise, 'pronounce');
  db.close();
  const s = saved(file);
  assert.equal(s.word1.completed, 0);
  assert.equal(s.position, 1);
});

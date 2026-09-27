import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { openDb, ensureUser, getEntryProgress, activeCourse, entryAt } from '../src/db.js';
import { upsertCourse, importEntries, validateEntries, parseCsv } from '../src/curriculum.js';

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
  assert.ok(importEntries(db, 'vol1', FIXTURE).ok);
  ensureUser(db, 'roy', 'Roy');
  return { db };
}

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
  const { db } = setup();
  const before = entryAt(db, 'vol1', 1).id;
  getEntryProgress(db, 'roy', before);
  const r = importEntries(db, 'vol1', FIXTURE);
  assert.ok(r.ok);
  assert.equal(entryAt(db, 'vol1', 1).id, before);
  getEntryProgress(db, 'roy', entryAt(db, 'vol1', 3).id);
  assert.equal(importEntries(db, 'vol1', FIXTURE.slice(0, 2)).ok, false, 'removing an entry with progress is refused');
  assert.ok(entryAt(db, 'vol1', 3), 'the refused import changed nothing');
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

test('JH Medics Volume 1 data file: 385 entries in source order', () => {
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
  assert.equal(entryAt(db, 'jh-medics-vol1', 385).english, 'Neuropathy');
  assert.equal(entryAt(db, 'jh-medics-vol1', 11).english, 'Regular physical examintion', 'source spelling kept');
  assert.equal(entryAt(db, 'jh-medics-vol1', 161).pinyin, '', 'no pinyin invented');
});

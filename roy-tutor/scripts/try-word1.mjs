// Runs a real Word 1 conversation against the configured AI provider (Qwen or
// OpenAI) and prints it. Uses the real curriculum, tutor engine and teacher, with
// a throwaway in-memory database, so saved progress is not touched.
//   npm run try-word1
import '../src/env.js';
import fs from 'node:fs';
import { openDb } from '../src/db.js';
import { upsertCourse, importEntries } from '../src/curriculum.js';
import { createTeacher } from '../src/teacher.js';
import { Tutor } from '../src/tutor.js';

const voice = (language) => ({ source: 'voice', alternatives: [], confidence: 0.85, language });

// Roy's side of the conversation: natural English, Mandarin, a misunderstanding,
// a correction and a role-play.
const TURNS = [
  ['硬膜外', voice('zh-CN'), 'says the Mandarin term'],
  ["Hmm, is that the injection they give women during labour? I'm not totally sure what it is.", voice('en-US'), 'natural English, unsure'],
  ['I think it means a kind of eye doctor.', voice('en-US'), 'misunderstanding'],
  ["Oh sorry, I mixed it up. It's an injection into the spine so the lower back stops feeling pain, like a local anaesthetic.", voice('en-US'), 'correction in own words'],
  ['医生建议打硬膜外。', voice('zh-CN'), 'Mandarin sentence'],
  ["Let's do a doctor and patient role-play. I'll be the interpreter.", voice('en-US'), 'asks for role-play'],
  ['医生说我们需要给你打硬膜外。', voice('zh-CN'), 'role-play turn'],
  ['病人问硬膜外会不会很痛？', voice('zh-CN'), 'role-play turn'],
];

const teacher = createTeacher();
console.log(`AI provider: ${teacher.label}, model ${teacher.model}, endpoint ${teacher.baseURL}`);
if (!teacher.configured) {
  console.error(`${teacher.keyName} is not configured.`);
  process.exit(1);
}

const db = openDb(':memory:');
const vol1 = JSON.parse(fs.readFileSync(new URL('../data/jh-medics-vol1.json', import.meta.url), 'utf8'));
upsertCourse(db, { ...vol1.course, status: 'active' });
importEntries(db, vol1.course.id, vol1.entries);
const tutor = new Tutor({ db, teacher });

const say = (r) => r.say.map((s) => s.show ?? s.text).join(' ');
const state = (r) => `[exercise=${r.exercise ?? '-'} mic=${r.listen ?? '-'} word ${r.card?.position ?? '-'}]`;

try {
  let r = await tutor.start();
  console.log(`\nTUTOR ${state(r)}\n  ${say(r)}`);
  for (const [text, meta, note] of TURNS) {
    console.log(`\nROY (${note}): ${text}`);
    r = await tutor.message(text, meta);
    console.log(`TUTOR ${state(r)}\n  ${say(r)}`);
  }
  const s = tutor.status();
  console.log(`\nEnd: word ${s.position} of ${s.total}, completed ${s.completed}.`);
} catch (err) {
  console.error(`\nStopped: ${err.constructor.name}: ${err.message}`);
  process.exit(1);
}

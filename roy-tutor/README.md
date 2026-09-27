# Roy Medical Chinese Tutor

A voice-first tutor that teaches Roy medical Mandarin from **JH Medics Volume 1**,
one entry at a time, in book order.

## Run it

Needs Node 22.5 or later (uses the built-in `node:sqlite`).

```
cd roy-tutor
npm install
npm start            # http://localhost:3000
npm test
```

Open the page in Chrome or Edge, since those browsers support speech input. Press **🎙 START TALKING**.
The tutor speaks, then the microphone opens in the language it expects the answer
in (Mandarin or English).

### Environment variables (server only)

| Variable | Purpose |
|---|---|
| `ANTHROPIC_API_KEY` | Optional. Turns on Claude for sentence checking and role-play. Without it, built-in checks and scripted scenes are used. |
| `TUTOR_MODEL` | Claude model, default `claude-opus-5`. |
| `TUTOR_ACCESS_CODE` | Optional passcode. The browser asks for it once. Set it when the app is on the internet. |
| `TUTOR_TIMEZONE` | Roy's time zone (for example `Asia/Shanghai`), used to decide when a new study day starts. |
| `TUTOR_DB` | SQLite file path, default `roy-tutor/tutor.db`. |
| `PORT` | Default `3000`. |

The API key is only read by the server (`src/ai.js`). The browser never sees it.

## What Roy can say

| Roy says | Tutor does |
|---|---|
| "Let's continue" | Resumes from the saved position (and ends a side trip). |
| "I don't understand" | Explains the current term again from the curriculum. |
| "I forgot" | Gives a hint, lets him try again, then gives the answer. |
| "Repeat" | Says the last question again. |
| "Jump to *word* / go to word 12" | Side trip to that entry. His curriculum position does not change. |
| "Back to the curriculum" | Ends the side trip. |
| "I'll be the doctor" / "You are the patient" | Sets his role-play role (Doctor, Patient, Interpreter, Nurse, Hospital staff). |
| "Stop" / "That's all for today" | Saves a session summary and ends. |

Chinese forms (继续, 我忘了, 我不懂, 再说一遍, 结束) work too.

## How a study day runs

1. Load progress.
2. On a new day: "Welcome back, Roy. Yesterday we studied …", then review those
   words plus up to 5 weak words. Wrong answers are corrected, marked weak and
   asked again once.
3. After review, carry on with the next unfinished entry:
   English → Mandarin → pinyin → JH Medics meaning → Roy says it → recognition
   test → Roy's own sentence → short role-play → mark complete → next entry.

An entry is marked weak if Roy made two or more mistakes on it.

## Layout

```
server.js              HTTP server and JSON API
src/tutor.js           tutor logic: review, lesson steps, jumps, role-play, progress
src/intents.js         spoken command detection
src/match.js           answer checking (characters or toneless pinyin)
src/ai.js              Claude calls (server side only)
src/db.js              SQLite schema and queries
src/curriculum.js      curriculum validation and import
data/                  curriculum files (see data/README.md)
public/                the voice interface
```

Database tables: `courses`, `curriculum` (id, course_id, position, english,
mandarin, pinyin, meaning, source_page), `user_progress` (user, course,
current_position, last_study_date, last_session, review_required),
`entry_progress` (entry, completed, times_practiced, last_reviewed, confidence,
weak) and `study_sessions` (words studied, words reviewed, weak words, summary).

## Curriculum

See [`data/README.md`](data/README.md). **Only entry 1 is loaded so far, and its
meaning is blank** because the JH Medics wording wasn't provided. Add the full
volume to `data/jh-medics-vol1.json`, or import a CSV, and restart. Volume 2 is
not loaded. The steps to add it later are in the same file.

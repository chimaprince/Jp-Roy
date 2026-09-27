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

## Answering by voice

Tap **🎙 START TALKING**. The tutor speaks, the microphone opens, Roy answers,
and the tutor replies. It then listens again, without Roy tapping anything. The badge under the button
shows the state: IDLE → TEACHER RESPONSE → LISTENING → PROCESSING →
TEACHER RESPONSE → LISTENING AGAIN. Tapping the button while the tutor is
speaking skips to answering, and tapping it while listening pauses.

The browser's speech recogniser turns speech into text (with up to five
guesses and a confidence score) and the server evaluates it in one of two modes:

- **Pronunciation** (saying the Mandarin term, and review questions). The tutor
  checks whether the recogniser heard the expected characters, first in its top
  guess and then in its other guesses, and names the syllables it did not hear.
  With `ANTHROPIC_API_KEY` set, Claude looks at the characters the recogniser
  wrote instead (for example 应 for 硬) and says which tone or sound probably
  slipped.
  **Limit:** this is a check of what the recogniser heard, not an acoustic
  tone score. The browser does not give the server any audio, so tones can
  only be inferred. The tutor tells Roy this the first time it corrects him.
- **Answer / conversation** (meaning, sentence, role-play). With Claude on,
  any natural answer that shows the meaning is accepted. Without it, the
  built-in check accepts the English term or most of the key words of the JH
  Medics meaning, so while an entry's meaning is missing only the English term
  itself is accepted.

Each exercise repeats, with more help each time, until Roy gets it right. A word is
only marked complete after all four exercises are passed. "Jump to" and "Stop"
still work at any time.

Typing (the "type instead" box) works as a fallback. Typed Mandarin is
checked for the right word, but it can't check pronunciation.

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

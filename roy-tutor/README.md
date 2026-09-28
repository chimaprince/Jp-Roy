# Roy Medical Chinese Tutor

A voice-first tutor that teaches Roy medical Mandarin from **JH Medics Volume 1**,
one entry at a time, in book order.

## Run it

Needs Node 22.5 or later (uses the built-in `node:sqlite`).

```
cd roy-tutor
npm install
cp .env.example .env      # then fill in QWEN_API_KEY (or OPENAI_API_KEY)
npm run check-ai          # checks the network path and key for the chosen provider
npm run try-word1         # a real Word 1 conversation with the AI, printed
npm start                 # http://localhost:3000
npm test
```

On startup the terminal shows the AI provider, the `.env` file used, that the key
was detected (value hidden) and the model and endpoint. Every turn then logs a
`[teacher] -> Qwen chat.completions ...` (or OpenAI) line and the reply's id. `.env` is ignored by Git; never commit it.

Open the page in Chrome or Edge (speech input). Press **🎙 START TALKING**.

### Settings (server only; in `.env` or the shell)

| Variable | Purpose |
|---|---|
| `AI_PROVIDER` | `qwen` (primary) or `openai`. If unset: Qwen when a Qwen key is present, otherwise OpenAI. |
| `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`) | Key for Qwen through Alibaba Cloud Model Studio's OpenAI-compatible API. |
| `QWEN_MODEL` | Default `qwen-plus`. |
| `QWEN_BASE_URL` | Default `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (international). Mainland China: `https://dashscope.aliyuncs.com/compatible-mode/v1`. |
| `OPENAI_API_KEY` | Key for OpenAI, used when `AI_PROVIDER=openai`. |
| `OPENAI_MODEL` | Default `gpt-5.5`. |
| `OPENAI_REASONING_EFFORT` | Default `low` (faster replies for voice). |

The selected provider's key is **required**: without it lessons do not start and
the page shows "<KEY NAME> is not configured."; there is no scripted fallback.
Qwen replies use JSON mode and are checked against the lesson schema on the
server (one corrected retry, then an error); OpenAI uses a strict JSON schema.

| `TUTOR_ACCESS_CODE` | Optional passcode. The browser asks for it once. Set it when the app is on the internet. |
| `TUTOR_TIMEZONE` | Roy's time zone (for example `Asia/Shanghai`), used to decide when a new study day starts. |
| `TUTOR_DB` | SQLite file path, default `roy-tutor/tutor.db`. |
| `PORT` | Default `3000`. |

The API key is only read by the server (`src/teacher.js`). The browser never sees it.

## How the tutor works

The **tutor engine** (`src/tutor.js`) owns the lesson state and the rules that
must always hold: curriculum order, the exercises for each word (say it,
explain its meaning, use it in a sentence, role-play), when a word counts as
complete, the daily review, jumps that keep Roy's place, and progress in the
database.

The **AI teacher** (`src/teacher.js`, Qwen or OpenAI, server side) owns the
conversation. On every turn it receives the current entry (English, Mandarin,
pinyin with tones, source meaning), recent and weak words, the lesson state,
this session's conversation, and what Roy said, including the recogniser's
language, alternatives and confidence. It decides what Roy meant (an answer,
"I don't know", a hint request, a question, "did I pronounce that right?",
"let's continue", a role-play request, a jump, stop...), whether his answer
shows understanding, and replies naturally. It returns structured lesson state
(`intent`, `understood`, `correct`, `needs_retry`, `exercise_complete`,
`next_action`, `student_confidence`) together with the spoken reply. The engine
applies that decision, and an exercise only completes on an actual answer.

## Answering by voice

Tap **🎙 START TALKING**. The tutor speaks, the microphone opens, Roy answers,
and the tutor replies, then listens again. The badge under the button shows the
state: IDLE → TEACHER RESPONSE → LISTENING → PROCESSING → TEACHER RESPONSE →
LISTENING AGAIN.

The lesson state sets the recognition language: Mandarin for saying the term,
sentences, role-play and review; English for explaining the meaning. The
status line shows the language in use while listening. Chrome gets
`cmn-Hans-CN`; other browsers get `zh-CN`.

**Word recognition vs pronunciation.** The browser's speech recogniser gives
text, not audio. The server reports to the teacher whether the recogniser wrote
down the expected characters (`src/recognition.js`). That is word recognition,
not a pronunciation or tone score, and the teacher is told never to judge tones
from it. `assessPronunciation()` in `src/recognition.js` is the hook for real
audio-based scoring later; today it returns nothing, and the teacher says it
can't reliably judge tones yet.

Typing (the "type instead" box) is a fallback. Typed answers go to the same AI
teacher, marked as typed, and no pronunciation is claimed for them.

## What Roy can say

Anything natural: answers in his own words, "I don't know", "I forgot",
"give me a hint", "can you explain that again?", "why is it called that?",
"did I pronounce that correctly?", "let's practise it again", "can we role-play
this?", "I'll be the nurse", "let's continue", "go to word 12", "that's all for
today". The AI teacher works out what he means; jumps can only go to curriculum
entries and never change his saved place.

## How a study day runs

1. Load progress.
2. On a new day: "Welcome back, Roy. Yesterday we studied …", then review those
   words plus up to 5 weak words. A missed word is marked weak and asked again
   once.
3. After review, carry on with the next unfinished entry: the teacher
   introduces English, Mandarin, pinyin with tones and the JH Medics meaning,
   then works through saying it, explaining it, a sentence, and a short
   role-play. The word is complete when all four are done; then the next entry.

An entry is marked weak if Roy gave two or more wrong answers or needed help
twice on it.

## Layout

```
server.js              HTTP server and JSON API
src/tutor.js           tutor engine: lesson state, order, review, jumps, progress
src/teacher.js         the AI teacher: Qwen (primary) or OpenAI, server side only
src/recognition.js     word recognition from the transcript; pronunciation hook
src/intents.js         resolves a jump target to a curriculum entry
src/match.js           text normalisation helpers
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

All 385 entries of JH Medics Volume 1 are loaded from the source Word
document, in book order, with page numbers. See [`data/README.md`](data/README.md)
for how they were extracted and checked. Volume 2 is not loaded; the steps to add
it later are in the same file.

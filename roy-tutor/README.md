# Roy Medical Chinese Tutor

A voice-first tutor that teaches Roy medical Mandarin from **JH Medics Volume 1**,
one entry at a time, in book order.

## Run it

Needs Node 22.5 or later (uses the built-in `node:sqlite`).

```
cd roy-tutor
npm install
cp .env.example .env      # then fill in DASHSCOPE_API_KEY
npm run check-ai          # checks the network path, key and model for Qwen
npm run try-word1         # a real Word 1 conversation with Qwen, printed
npm start                 # http://localhost:3000
npm test
```

On startup the terminal shows `AI provider: Qwen`, the model, the endpoint and
`DASHSCOPE_API_KEY: detected (value hidden)`. Every turn then logs a
`[teacher] -> Qwen chat.completions ...` line and the reply's id. `.env` is ignored by Git; never commit it.

Open the page in Chrome or Edge (speech input). Press **🎙 START TALKING**.

### Settings (server only; in `.env` or the shell)

| Variable | Purpose |
|---|---|
| `DASHSCOPE_API_KEY` | **Required.** Key for Qwen (Alibaba Cloud Model Studio, OpenAI-compatible API), the tutor's only AI provider. |
| `QWEN_MODEL` | Default `qwen3.8-flash`. |
| `QWEN_BASE_URL` | Default `https://ws-c2mgxehx4ud1bn7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. |
| `QWEN_ENABLE_THINKING` | Default `false` (faster replies for voice). |

Without `DASHSCOPE_API_KEY` lessons do not start: the server and the page say
"Qwen is not configured: DASHSCOPE_API_KEY is missing." There is no scripted
fallback. Qwen replies use JSON mode and are checked against the lesson schema
on the server (one corrected retry, then an error).

| `TUTOR_ACCESS_CODE` | Optional passcode. The browser asks for it once. Set it when the app is on the internet. |
| `TUTOR_TIMEZONE` | Roy's time zone (for example `Asia/Shanghai`), used to decide when a new study day starts. |
| `TUTOR_DB` | SQLite file path, default `roy-tutor/tutor.db`. |
| `PORT` | Default `3000`. |
| `HOST` | Default `0.0.0.0` (reachable from your phone on the same Wi-Fi); `127.0.0.1` for this computer only. |
| `TUTOR_HTTPS_CERT`, `TUTOR_HTTPS_KEY` | Optional certificate and key files to serve over https (needed for the phone microphone). |

The API key is only read by the server (`src/teacher.js`). The browser never sees it.

## Testing on a phone (same Wi-Fi)

This is a local development setup, not a public deployment.

The server listens on all network adapters (`HOST=0.0.0.0`, the default) and
prints the address to use, for example:

```
Roy Medical Chinese tutor on http://localhost:3000
On your phone (same Wi-Fi), open:
  http://192.168.1.23:3000   (Wi-Fi)
```

`http://localhost:3000` keeps working on the laptop. Set `HOST=127.0.0.1` to
turn phone access off. Only the files in `public/` are served; `.env` and the
Qwen key stay on the laptop. Set `TUTOR_ACCESS_CODE` in `.env` so nobody else on
the network can use your Qwen quota (the page asks for it once).

**Windows Firewall.** The first time `npm start` listens on the network,
Windows shows "Windows Defender Firewall has blocked some features of
Node.js". Tick **Private networks** only and click **Allow access**. Your home
Wi-Fi must be set to *Private* (Settings → Network & internet → Wi-Fi → your
network → Network profile type → Private). If you dismissed the prompt, run
PowerShell as administrator:

```
New-NetFirewallRule -DisplayName "Roy tutor (dev) 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private -Action Allow
```

(remove it later with `Remove-NetFirewallRule -DisplayName "Roy tutor (dev) 3000"`).

**The microphone needs https or localhost.** Phone browsers block the
microphone and speech recognition on plain `http://192.168.x.x`. The page
still works there (the teacher speaks; you can type), and it says why the
microphone is off. To talk from the phone, use one of these:

1. *Android Chrome, quickest:* on the phone open
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enter
   `http://192.168.1.23:3000` (your address), set it to Enabled, relaunch
   Chrome. For testing only.
2. *USB cable (Android):* enable USB debugging on the phone, connect it, open
   `chrome://inspect/#devices` on the laptop, add port forwarding
   `3000 → localhost:3000`, then open `http://localhost:3000` on the phone.
3. *HTTPS with a local certificate (Android or iPhone):* install mkcert
   (`winget install FiloSottile.mkcert`), run `mkcert -install` and
   `mkcert -cert-file certs/lan.pem -key-file certs/lan-key.pem 192.168.1.23 localhost`
   in `roy-tutor`, add to `.env`:
   ```
   TUTOR_HTTPS_CERT=certs/lan.pem
   TUTOR_HTTPS_KEY=certs/lan-key.pem
   ```
   restart, and open `https://192.168.1.23:3000`. The phone must trust
   mkcert's root certificate (`mkcert -CAROOT` shows where `rootCA.pem` is;
   install it on the phone as a CA certificate). `certs/` is ignored by Git.

Speech recognition on the phone also needs the phone's own internet access
(Chrome sends the audio to Google). iPhone Safari's speech recognition is
less reliable than Chrome's.

## How the tutor works

The **tutor engine** (`src/tutor.js`) owns the lesson state and the rules that
must always hold: curriculum order, the exercises for each word (say it,
explain its meaning, use it in a sentence, role-play), when a word counts as
complete, the daily review, jumps that keep Roy's place, and progress in the
database.

The **AI teacher** (`src/teacher.js`, Qwen, server side) owns the
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

Chrome recognises one language at a time. When the lesson expects Mandarin
but Roy wants to say something in English ("I don't know", "can you explain
that again?"), or the reverse, he taps the **Mic: … · switch to …** button
under the status line. The switch lasts for that one answer; the next teacher
reply sets the language from the lesson again.

The teacher's replies are read by the browser's speech voices. Each line is
split by script, so Chinese characters are read by a Chinese voice and the rest
by an English voice. This is playback only, not pronunciation scoring.

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
src/teacher.js         the AI teacher (Qwen, server side only)
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

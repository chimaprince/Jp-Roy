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
npm run check-voice       # real Qwen TTS + ASR round trip (saves voice-check.wav)
npm start                 # http://localhost:3000
npm test
```

On startup the terminal shows `AI provider: Qwen`, the model, the endpoint and
`DASHSCOPE_API_KEY: detected (value hidden)`. Every turn then logs a
`[teacher] -> Qwen chat.completions ...` line and the reply's id, and every
voice step logs `[voice] -> Qwen ASR ...` / `[voice] -> Qwen TTS ...`. `.env` is ignored by Git; never commit it.

Open the page in any current browser (Chrome, Edge, Safari, iPhone Safari). Press **🎙 START TALKING**.

### Settings (server only; in `.env` or the shell)

| Variable | Purpose |
|---|---|
| `DASHSCOPE_API_KEY` | **Required.** Key for Qwen (Alibaba Cloud Model Studio, OpenAI-compatible API), the tutor's only AI provider. |
| `QWEN_MODEL` | Default `qwen3.8-flash`. |
| `QWEN_BASE_URL` | Default `https://ws-c2mgxehx4ud1bn7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. |
| `QWEN_ENABLE_THINKING` | Default `false` (faster replies for voice). |
| `QWEN_ASR_MODEL` | Speech recognition model. Default `qwen3-asr-flash`. |
| `QWEN_ASR_BASE_URL` | Default `https://dashscope-intl.aliyuncs.com/compatible-mode/v1` (Singapore). |
| `QWEN_TTS_MODEL` | Teacher voice model. Default `qwen3-tts-instruct-flash`. |
| `QWEN_TTS_URL` | Default `https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation` (Singapore). |
| `QWEN_TTS_VOICE` | Default `Cherry` (speaks Mandarin and English). |
| `QWEN_TTS_INSTRUCTIONS` | Speaking style for lines with Mandarin. Default: standard Putonghua, clear tones, slightly slow, patient medical-teacher tone (see `src/voice.js`). |
| `QWEN_TTS_INSTRUCTIONS_EN` | Speaking style for English-only lines. |
| `TUTOR_ACCESS_CODE` | Optional passcode. The browser asks for it once. Set it when the app is on the internet. |
| `TUTOR_TIMEZONE` | Roy's time zone (for example `Asia/Shanghai`), used to decide when a new study day starts. |
| `TUTOR_DB` | SQLite file path, default `roy-tutor/tutor.db`. |
| `PORT` | Default `3000`. |
| `HOST` | Default `0.0.0.0` (reachable from your phone on the same Wi-Fi); `127.0.0.1` for this computer only. |
| `TUTOR_HTTPS_CERT`, `TUTOR_HTTPS_KEY` | Optional certificate and key files to serve over https (needed for the phone microphone). |

Without `DASHSCOPE_API_KEY` lessons do not start: the server and the page say
"Qwen is not configured: DASHSCOPE_API_KEY is missing." There is no scripted
fallback. Qwen replies use JSON mode and are checked against the lesson schema
on the server (one corrected retry, then an error).

The API key is only read by the server (`src/teacher.js`, `src/voice.js`). The
browser never sees it, and never talks to Qwen directly: it uploads recordings
to this server and downloads the teacher's audio from this server. The same
key is used for the teacher, ASR and TTS, so it must be a key for the region of
those endpoints (Singapore by default for voice).

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
microphone on plain `http://192.168.x.x`. The page still works there (the
teacher speaks; you can type), and it says why the microphone is off. To talk
from the phone, use one of these (on iPhone, only option 3 works):

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

   **iPhone, step by step:** after `mkcert -install`, AirDrop or email
   `rootCA.pem` (from the `mkcert -CAROOT` folder) to the iPhone and open it;
   then Settings › General › VPN & Device Management › install the profile;
   then Settings › General › About › Certificate Trust Settings › turn on full
   trust for the mkcert root. Open `https://192.168.1.23:3000` in Safari, tap
   START TALKING and allow the microphone.

Speech recognition and the teacher's voice run on the laptop (Qwen), so the
phone only needs to reach the laptop over Wi-Fi.

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

Tap **🎙 START TALKING**. The teacher speaks, the microphone opens, Roy answers,
and the teacher replies, then listens again. The badge under the button shows
each step:

IDLE → TEACHER THINKING → PREPARING TEACHER VOICE → TEACHER AUDIO READY →
TEACHER SPEAKING → LISTENING → AUDIO CAPTURED → TRANSCRIPT RECEIVED →
TEACHER THINKING → … → LISTENING AGAIN

**Speech in (Qwen ASR).** The page records with the microphone (`MediaRecorder`;
iPhone Safari records mp4), stops when Roy pauses (or when he taps
**✋ DONE TALKING**), converts the recording to 16 kHz mono WAV and uploads it
to `POST /api/voice/transcribe`. The server sends it to **qwen3-asr-flash** with
the lesson's language as a hint: Mandarin for saying the term, sentences,
role-play and review; English for explaining the meaning. The transcript then
goes to the tutor exactly like a typed answer (marked as voice). If Roy wants
to answer in the other language ("I don't know" during a Mandarin exercise),
he taps **Answer language: … · switch to …** for that one answer.

If Qwen ASR fails, the page says so, nothing is counted, and **↻ RETRY** sends
the same recording again. If no words were recognised, Roy is asked to say it
again.

**Speech out (Qwen TTS).** Each line of the teacher's reply is sent by the
server to **qwen3-tts-instruct-flash** (voice `Cherry`, Chinese mode for any line with
Mandarin in it, with instructions to speak standard Putonghua clearly, tones distinct,
a little slowly, like a patient medical Chinese teacher) as soon as the teacher has answered. The page fetches the audio
from `GET /api/voice/speech/<id>` and plays it. Only lines the tutor itself
produced can be spoken; the page cannot ask the server to say arbitrary text.
If TTS fails, the teacher's text is shown in the conversation and the lesson
carries on. The browser's built-in speech recognition and speech voices are not
used at all.

**Word recognition vs pronunciation.** Qwen ASR gives text, not a score. The server reports to the teacher whether the recogniser wrote
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
src/voice.js           Qwen speech recognition and teacher voice (server side only)
src/recognition.js     word recognition from the transcript; pronunciation hook
src/intents.js         resolves a jump target to a curriculum entry
src/match.js           text normalisation helpers
src/db.js              SQLite schema and queries
src/curriculum.js      curriculum validation and import
data/                  curriculum files (see data/README.md)
public/                the voice interface (records audio, plays the teacher audio)
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

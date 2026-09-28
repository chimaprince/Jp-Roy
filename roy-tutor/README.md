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
npm run start:https       # https://localhost:3443 (phone microphone; see below)
npm test
```

On startup the terminal shows `AI provider: Qwen`, the model, the endpoint and
`DASHSCOPE_API_KEY: detected (value hidden)`. Every turn then logs a
`[teacher] -> Qwen chat.completions ...` line and the reply's id, and every
voice step logs `[voice] -> Qwen ASR ...` / `[voice] -> Qwen TTS ...`. `.env` is ignored by Git; never commit it.

Open the page in any current browser (Chrome, Edge, Safari, iPhone Safari). Press **🎙 START TALKING**.

### Settings (server only; in `.env` or the shell)

`roy-tutor/.env` is the source of truth: a value there replaces the same
variable set in the shell or the Windows environment, and the startup log (and
`npm run check-voice`) prints a `note:` whenever that happens. Duplicate lines in
`.env` and a second, unused `.env` file are reported too. `TUTOR_ENV_FILE=<path>`
loads another file; `TUTOR_ENV_FILE=none` loads none (the tests use this).

| Variable | Purpose |
|---|---|
| `DASHSCOPE_API_KEY` | **Required.** Key for Qwen (Alibaba Cloud Model Studio, OpenAI-compatible API), the tutor's only AI provider. |
| `QWEN_MODEL` | Default `qwen3.8-flash`. |
| `QWEN_BASE_URL` | Default `https://ws-c2mgxehx4ud1bn7.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. |
| `QWEN_ENABLE_THINKING` | Default `false` (faster replies for voice). |
| `QWEN_ASR_MODEL` | Speech recognition model. Default `qwen-audio-3.1-asr-flash` (DashScope native API). `qwen3-asr-*` models use the OpenAI-compatible API instead. |
| `QWEN_ASR_BASE_URL` | Your Singapore workspace host: `https://<WORKSPACE_ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1` (workspace ID from Model Studio). For `qwen-audio-*` models the request goes to `/api/v1/services/aigc/multimodal-generation/generation` on this host. If unset: `dashscope-intl.aliyuncs.com`. |
| `QWEN_ASR_URL` | Optional: the full ASR endpoint, overriding the one derived from `QWEN_ASR_BASE_URL`. |
| `QWEN_ASR_CONTEXT` | Default on: the current lesson term (Mandarin, pinyin, English) and a medical-Chinese note are sent as recognition context. `off` to disable. |
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
| `TUTOR_HTTPS_CERT`, `TUTOR_HTTPS_KEY` | Optional certificate and key files to serve over https (needed for the phone microphone). `npm run start:https` makes its own if these are not set. |
| `TUTOR_SETUP_PORT` | HTTPS mode: port of the plain-HTTP phone setup page. Default `3000`; `off` to disable. |
| `TUTOR_HTTPS_HOSTS` | HTTPS mode: extra host names/IPs for the development certificate (comma-separated). |

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
teacher speaks; you can type), and it says why the microphone is off.

### HTTPS development mode (`npm run start:https`) - iPhone microphone

```
npm run start:https
```

This runs the same tutor app and API as `npm start`, but over HTTPS on port
**3443**, on every network adapter (`0.0.0.0`). On first run it creates, in
`roy-tutor/certs/` (ignored by Git):

- `dev-ca.crt`: a private certificate authority for this laptop only. This is
  the file the phone trusts, once.
- `dev-server.crt`: the HTTPS certificate, signed by that CA, for `localhost`,
  `127.0.0.1`, the Windows Mobile Hotspot address `192.168.137.1` and every
  current network address. It is re-issued automatically when the addresses
  change. Extra names can go in `TUTOR_HTTPS_HOSTS` (comma-separated).
- The two `*-key.pem` private keys. They never leave the laptop and are never
  served.

It also starts a small **plain-HTTP phone setup page on port 3000**. It offers
only the CA certificate download and sends everything else to HTTPS; the tutor
API is not served over plain HTTP in this mode. Stop `npm start` first,
because both use port 3000 (or set `TUTOR_SETUP_PORT`). The terminal prints the
exact addresses, for example:

```
Roy Medical Chinese tutor on https://localhost:3443
On your phone (same Wi-Fi or the laptop's hotspot), open:
  https://192.168.137.1:3443   (Local Area Connection* 10 - Windows Mobile Hotspot: use this one for a phone on the hotspot)
First time on the iPhone: trust the development certificate. In Safari open:
  http://192.168.137.1:3000/   (Local Area Connection* 10, hotspot)
  Certificate fingerprint (SHA-256): AB:CD:...
```

A phone on the laptop's **Mobile Hotspot** reaches the laptop at its hotspot
address (usually `192.168.137.1`), not at the laptop's Wi-Fi address.

**Windows Firewall** (PowerShell as administrator, once):

```
New-NetFirewallRule -DisplayName "Roy tutor (dev) https 3443" -Direction Inbound -Protocol TCP -LocalPort 3443 -Profile Private,Public -Action Allow
New-NetFirewallRule -DisplayName "Roy tutor (dev) setup 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private,Public -Action Allow
```

(The hotspot network is often classed as *Public*, hence both profiles.
Remove the rules later with `Remove-NetFirewallRule -DisplayName "Roy tutor (dev) https 3443"`
and `... "Roy tutor (dev) setup 3000"`.)

**Trust the certificate on the iPhone (once):**

1. In **Safari** on the iPhone open `http://192.168.137.1:3000/` and tap
   **Download certificate**, then **Allow**. ("Profile Downloaded".)
2. Settings › General › VPN & Device Management › **Roy Tutor Local Dev CA** ›
   Install (enter the passcode) › Install.
3. Settings › General › About › Certificate Trust Settings › turn **on** full
   trust for **Roy Tutor Local Dev CA** › Continue.
4. Open `https://192.168.137.1:3443` in Safari. There should be no warning.
   Tap START TALKING and allow the microphone.

To undo: Settings › General › VPN & Device Management › the profile › Remove.
If you delete `certs/`, a new CA is created and the phone must trust the new
one.

Other options (Android): open
`chrome://flags/#unsafely-treat-insecure-origin-as-secure` and add
`http://<laptop-ip>:3000`, or use USB port forwarding from
`chrome://inspect/#devices` to reach `http://localhost:3000`. Your own
certificate (for example from mkcert) also works: set `TUTOR_HTTPS_CERT` and
`TUTOR_HTTPS_KEY` in `.env`.

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
to `POST /api/voice/transcribe`. The server sends it to **qwen-audio-3.1-asr-flash**
(your Singapore workspace host) with the lesson's language as a hint: Mandarin
for saying the term, sentences, role-play and review; English for explaining
the meaning. The current JH Medics term (characters, pinyin, English) is sent
as recognition context so medical vocabulary is recognised better. That can
also make a near-miss come out as the correct characters, so the transcript is
word recognition, not proof of pronunciation. If Alibaba rejects the context
or language hint as invalid (HTTP 400), the server retries without the context,
then without the hint, and logs each attempt. The transcript then
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

**The transcript is evidence, not ground truth.** Chinese has many characters
with the same sound, so the recogniser sometimes writes the wrong one even when
Roy says the word correctly (a real case: 硬膜外 said correctly, transcribed as
硬磨外, since 磨 is also mó). `src/evaluation.js` compares the transcript with
the current term **sound by sound**, using the curriculum pinyin and a
dictionary of character readings (`pinyin-pro`). It finds the term even inside a
longer answer and gives one of four levels:

| Level | Meaning | What happens |
|---|---|---|
| `high_confidence_correct` | exactly the expected characters | counted as correct |
| `likely_correct_asr_character_mismatch` | every syllable has the same sound and tone; only the characters differ | the teacher says it heard the word and points out the character in the term (for example "The recogniser wrote 磨, but the character in our medical term is 膜"); **never counted as a mistake** |
| `uncertain` | a tone differs, a commonly confused sound (zh/z, n/l, in/ing…), one syllable of a longer term, or pinyin letters only | the teacher says it didn't quite catch it and asks again; no verdict is forced |
| `clearly_incorrect` | the expected sounds are missing | **never marked correct**, even if the AI teacher says so |

The teacher is told to keep "your pronunciation" apart from "what the
recogniser transcribed". The two engine rules (in the table) apply to the
say-the-term and review exercises. If the teacher's reply contradicts the
evidence, it is asked once more, and the lesson state follows the evidence either
way. In sentences and role-play the evaluation only says whether the term was
used. Typed answers are taken as typed. This is still not a tone score: with
audio only through a transcript, tones cannot be judged directly.
`assessPronunciation()` in `src/recognition.js` remains the hook for real
audio-based scoring later.

## Listen & Learn

The home screen shows Roy's current word and two buttons: **🎙 Interactive
Practice** (the voice lessons above) and **🎧 Listen & Learn**. In Listen & Learn
Roy only listens. Nothing is asked, the microphone is never used, and no
progress changes. For each word the Qwen voice:

1. says the Mandarin term clearly;
2. says it again, slowly, with the **pinyin shown on screen** (pinyin is never
   sent to the voice; a Mandarin voice reads characters, not letters);
3. gives the English;
4. reads the JH Medics medical meaning, verbatim;
5. goes syllable by syllable, shown as `硬 yìng · 膜 mó · 外 wài`, but only
   when every character has a single reading, so the voice cannot choose a
   wrong one;
6. says the term once more.

JH Medics Volume 1 has no example sentences, so there is no sentence step and
none is invented. Sentences are practised in Interactive Practice.

Controls: **▶ Play**, **⏸ Pause**, **↻ Repeat** (this step again, or the whole
word once finished), **→ Next** (the next word in book order), and **Exit
Listen Mode**. Listening to later words is only a preview: Roy's place in the
curriculum moves only by completing words in Interactive Practice. The lesson
comes from `GET /api/listen?position=N` (read-only). Each line is synthesised
once and reused on repeats, to save TTS quota.

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
src/recognition.js     pinyin helpers; pronunciation-scoring hook
src/evaluation.js      ASR-aware answer evaluation (same sound vs same character)
src/listen.js          Listen & Learn lesson script from the curriculum
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

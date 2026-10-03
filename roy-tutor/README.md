# Roy Medical Chinese Tutor

A voice-first tutor: **one permanent AI teacher** for any medical-Chinese course
document. The document is **what** Roy learns; the teacher is **how** he is
taught, and that never changes. The first course is **JH Medics Volume 1**
(385 entries); when it is finished, Roy hands the teacher the next document
(see "Courses"). Items are taught one at a time, in the document's order. Two
ways to learn, sharing one place in the course:

- **🎙 Interactive Practice**: a spoken conversation with an AI teacher (Qwen).
  Roy says the word, explains it, uses it in a sentence and role-plays it.
- **🎧 Listen & Learn**: hands-free. Put on earphones and the teacher teaches word
  after word until you pause.

Everything that needs the Qwen key happens on the server. The phone only
records audio and plays audio.

```
phone microphone → server → Qwen ASR (qwen-audio-3.1-asr-flash) → tutor + Qwen teacher
→ Qwen TTS (qwen3-tts-instruct-flash, voice Cherry) → server → phone speaker
```

## Everyday use (phone or laptop)

1. On the laptop, double-click **`start-tutor.cmd`** in the `roy-tutor` folder
   (the same as `npm run start:https`). Leave the window open. It prints the
   address to open.
2. **iPhone:** open the printed `https://192.168.137.1:3443` address in Safari
   (laptop hotspot; on shared Wi-Fi use the other address it prints). The first
   time only, trust the development certificate (see below).
   **Laptop:** open `https://localhost:3443`.
3. Allow the microphone when asked (needed for Interactive Practice only).
4. **🎧 Listen & Learn:** put on earphones and press it once. The teacher teaches
   each word and moves on to the next by itself. ⏸ Pause, ▶ Play, ↻ Repeat and
   → Next are there if you want them.
5. **🎙 Interactive Practice:** press it and talk with the teacher.

Both modes share one place in the course, so you always continue where you
stopped.

## Quick start

Needs Node 22.5 or later (uses the built-in `node:sqlite`).

```
cd roy-tutor
npm install
cp .env.example .env        # then fill in the values below (never commit .env)
npm test                    # the full test suite, offline (Qwen is replaced by stand-ins)
npm run check-voice         # real Qwen TTS + ASR round trip with your key
npm run start:https         # https://<laptop-ip>:3443, for the iPhone microphone
```

Other scripts: `npm start` (plain http on port 3000: fine on the laptop itself,
but a phone cannot use the microphone over plain http), `npm run check-ai`
(network, key and model check for the Qwen teacher), `npm run try-word1` (a real
Word 1 conversation, printed).

## .env

`roy-tutor/.env` is the source of truth: a value there replaces the same variable
set in the shell or the Windows environment, and the startup log (and
`npm run check-voice`) prints a `note:` whenever that happens. Duplicate lines and
a second, unused `.env` file are reported too.

What Roy's setup needs (Singapore workspace):

```
DASHSCOPE_API_KEY=<your key>
QWEN_BASE_URL=<the teacher's compatible-mode URL, e.g. https://dashscope-intl.aliyuncs.com/compatible-mode/v1>
QWEN_MODEL=<the teacher model authorised in your workspace>
QWEN_ASR_MODEL=qwen-audio-3.1-asr-flash
QWEN_ASR_BASE_URL=https://<WORKSPACE_ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1
TUTOR_ACCESS_CODE=<any passcode>
TUTOR_TIMEZONE=<e.g. Asia/Singapore>
```

| Variable | Purpose |
|---|---|
| `DASHSCOPE_API_KEY` | **Required.** The Qwen key (Alibaba Cloud Model Studio). Used for the teacher, ASR and TTS, so it must be valid for those endpoints' region. |
| `QWEN_MODEL`, `QWEN_BASE_URL` | The teacher (chat, OpenAI-compatible API). Defaults `qwen3.8-flash` and a Beijing workspace URL; set both for your workspace. |
| `QWEN_ENABLE_THINKING` | Default `false` (faster replies for voice). |
| `QWEN_TIMEOUT_MS` | Timeout for each teacher request, default `30000`, with one retry. |
| `QWEN_ASR_MODEL` | Speech recognition. Default `qwen-audio-3.1-asr-flash` (DashScope native API). `qwen3-asr-*` models use the OpenAI-compatible API instead. |
| `QWEN_ASR_BASE_URL` | Your Singapore workspace host. For `qwen-audio-*` models the request goes to `/api/v1/services/aigc/multimodal-generation/generation` on that host. `QWEN_ASR_URL` sets the full endpoint instead. |
| `QWEN_ASR_CONTEXT` | Default on: the current term and a medical-Chinese note are sent as recognition context. `off` to disable. |
| `QWEN_TTS_MODEL`, `QWEN_TTS_URL`, `QWEN_TTS_VOICE` | The teacher's voice. Defaults `qwen3-tts-instruct-flash`, the Singapore endpoint, `Cherry`. |
| `QWEN_TTS_INSTRUCTIONS`, `QWEN_TTS_INSTRUCTIONS_EN` | Speaking style for Mandarin / English lines. Default: standard Putonghua, clear tones, slightly slow, a patient medical teacher. |
| `QWEN_TTS_MIN_GAP_MS`, `QWEN_TTS_RETRY_MS` | TTS pacing: minimum gap between requests (default `250`) and the waits before retrying a 429 (default `1000,3000,8000`). |
| `TUTOR_AUDIO_CACHE` | Folder for the teacher-audio cache (default `audio-cache/` next to the database), or `off`. |
| `TUTOR_ACCESS_CODE` | Passcode for every API route (lessons, voice, Listen & Learn). The page asks for it once. Set it so others on the same network cannot use your Qwen quota. |
| `TUTOR_TIMEZONE` | Decides when a new study day starts (and so the review). |
| `TUTOR_DB` | SQLite file, default `roy-tutor/tutor.db`. |
| `PORT`, `HOST` | Default `3000` (`3443` for `start:https`) and `0.0.0.0` (reachable from the phone); `HOST=127.0.0.1` for this computer only. |
| `TUTOR_HTTPS_CERT`, `TUTOR_HTTPS_KEY` | Your own certificate for HTTPS; `start:https` makes a development one if these are not set. |
| `TUTOR_SETUP_PORT`, `TUTOR_HTTPS_HOSTS` | HTTPS mode: port of the phone setup page (default `3000`, `off` to disable); extra certificate names/IPs. |
| `TUTOR_ENV_FILE` | Load another env file, or `none` (the tests use this). |

The key is only read by the server (`src/teacher.js`, `src/voice.js`,
`src/listencontent.js`). The browser never sees it and never talks to Qwen: it
uploads recordings to this server and downloads the teacher's audio from it.
Without a key, lessons do not start: the server and the page say "Qwen is not
configured: DASHSCOPE_API_KEY is missing." There is no scripted fallback teacher.

## iPhone: HTTPS and the development certificate

Phones allow the microphone only on `https://` (or `localhost`).
`npm run start:https` runs the same app and API over HTTPS on port **3443**, on
every network adapter, so a phone on the same Wi-Fi or on the laptop's **Mobile
Hotspot** can use it. This is a local development setup, not a public
deployment.

On first run it creates, in `roy-tutor/certs/` (ignored by Git):

- `dev-ca.crt`: a private certificate authority for this laptop only. The phone
  trusts it once.
- `dev-server.crt`: the HTTPS certificate, signed by that CA, for `localhost`,
  `127.0.0.1`, the hotspot address `192.168.137.1` and every current network
  address. It is re-issued automatically when the addresses change.
- `*-key.pem`: the private keys. They never leave the laptop and are never served.

It also starts a small **plain-HTTP setup page on port 3000**. It offers only the
certificate download and sends everything else to HTTPS. The terminal prints the
exact addresses:

```
Roy Medical Chinese tutor on https://localhost:3443
On your phone (same Wi-Fi or the laptop's hotspot), open:
  https://192.168.137.1:3443   (Local Area Connection* 10 - Windows Mobile Hotspot: use this one for a phone on the hotspot)
First time on the iPhone: trust the development certificate. In Safari open:
  http://192.168.137.1:3000/   (Local Area Connection* 10, hotspot)
  Certificate fingerprint (SHA-256): AB:CD:...
```

A phone on the laptop's hotspot reaches the laptop at the hotspot address
(usually `192.168.137.1`), not at the laptop's Wi-Fi address.

**Windows Firewall** (PowerShell as administrator, once; the hotspot network is
often *Public*, hence both profiles):

```
New-NetFirewallRule -DisplayName "Roy tutor (dev) https 3443" -Direction Inbound -Protocol TCP -LocalPort 3443 -Profile Private,Public -Action Allow
New-NetFirewallRule -DisplayName "Roy tutor (dev) setup 3000" -Direction Inbound -Protocol TCP -LocalPort 3000 -Profile Private,Public -Action Allow
```

**Trust the certificate on the iPhone (once):**

1. In **Safari** open `http://192.168.137.1:3000/`, tap **Download certificate**,
   then **Allow**.
2. Settings › General › VPN & Device Management › **Roy Tutor Local Dev CA** ›
   Install.
3. Settings › General › About › Certificate Trust Settings › turn **on** full
   trust for **Roy Tutor Local Dev CA**.
4. Open `https://192.168.137.1:3443` in Safari. There should be no warning.

To undo, remove the profile in VPN & Device Management. If `certs/` is deleted, a
new CA is made and the phone must trust it again.

## Interactive Practice

Tap **🎙 Interactive Practice**. The teacher speaks, the microphone opens, Roy
answers, and the teacher replies, then listens again. The badge shows each step:
TEACHER THINKING → PREPARING TEACHER VOICE → TEACHER AUDIO READY → TEACHER
SPEAKING → LISTENING → AUDIO CAPTURED → TRANSCRIPT RECEIVED → …

For each word, the teacher works through four exercises: say the Mandarin,
explain the meaning in English, make a sentence, and a short role-play (Roy as
interpreter, doctor, patient, nurse or hospital staff). The word is complete
when all four are done.

Before asking for Roy's sentence, the teacher teaches practical usage: how the
term is used in real medical communication, where Roy would hear or use it
(doctor, patient, interpreter), and a model sentence containing the exact term
(for 硬膜外: 我们需要给你做硬膜外麻醉。). If Listen & Learn has already stored a
checked example for that word, the teacher uses the same one.

- **The tutor engine** (`src/tutor.js`) owns the rules: curriculum order, which
  exercise comes next, when a word is complete, review, side trips that keep
  Roy's place, and progress.
- **The AI teacher** (`src/teacher.js`, Qwen) owns the conversation. It works out
  what Roy meant: an answer (right, wrong or partial), "I don't know", "I don't
  understand", a hint request, "say it again", "let's continue", a question, a
  role-play request, "go to word 12", "that's all for today", or small talk. It
  replies naturally. Only an actual answer can complete an exercise.

**Speech in.** The page records (`MediaRecorder`; iPhone Safari records mp4),
stops when Roy pauses or taps **✋ DONE TALKING**, converts the recording to 16 kHz
WAV and uploads it. The server sends it to **qwen-audio-3.1-asr-flash** with the
lesson language as a hint (Mandarin, or English for the meaning exercise) and the
current term as context. Roy can switch the answer language for one answer. If ASR
fails, nothing is counted and **↻ RETRY** sends the same recording again.

**The transcript is evidence, not ground truth.** Chinese has many characters
with the same sound, so the recogniser can write the wrong one when Roy says the
word correctly (real case: 硬膜外 said correctly, transcribed 硬磨外, since 磨 is
also mó). `src/evaluation.js` compares the transcript with the term **sound by
sound** (curriculum pinyin plus a dictionary of character readings):

| Level | Meaning | What happens |
|---|---|---|
| `high_confidence_correct` | exactly the expected characters | counted as correct |
| `likely_correct_asr_character_mismatch` | same syllables and tones, other characters | the teacher says it heard the word and names the right character ("The recogniser wrote 磨, but the character in our term is 膜"); **never counted as a mistake** |
| `uncertain` | a tone, a commonly confused sound (zh/z, n/l…), or one syllable differs | "I didn't quite catch it", asked again; no verdict forced |
| `clearly_incorrect` | the expected sounds are missing | **never marked correct**, even if the AI teacher says so |

The teacher keeps "your pronunciation" apart from "what the recogniser
transcribed". If its reply contradicts the evidence, it is asked once more, and
the lesson state follows the evidence either way. Typed answers ("type
instead") are taken as typed. Tones cannot be judged from a transcript;
`assessPronunciation()` in `src/recognition.js` is the hook for real audio
scoring later.

**Speech out.** Each line of the teacher's reply is spoken by
**qwen3-tts-instruct-flash** (Cherry, Chinese mode for any line with Mandarin).
The page plays it from `GET /api/voice/speech/<id>`. Only lines the tutor
produced can be spoken. If TTS fails, the text is shown and the lesson carries
on. The browser's own speech recognition and speech voices are not used at all.

**Qwen TTS load (rate limits).** Qwen limits how many TTS requests a workspace
may send (HTTP 429, `Throttling.RateQuota`). The server (`SpeechStore` in
`src/voice.js`) therefore:

- gives each line an id but asks Qwen for nothing until the page asks for that
  line's audio. The page asks one line at a time, as it plays them, plus the
  next line ahead;
- sends **one** TTS request at a time, at least `QWEN_TTS_MIN_GAP_MS` apart
  (default 250 ms);
- shares a request already on its way for the same line (deduplication);
- caches audio by a hash of model, voice, language, speaking style and text,
  in memory and on disk (`audio-cache/` next to the database; `TUTOR_AUDIO_CACHE`
  to move it, `off` to disable). A line said before, on Repeat, a later day or
  after a restart, is never requested again;
- on 429 waits and retries (after 1 s, 3 s, 8 s: `QWEN_TTS_RETRY_MS`) while
  holding the queue, then stops with "Qwen's voice is busy right now (rate
  limit)". Listen & Learn pauses on that line (nothing is completed) and ▶ Play
  tries again;
- drops a queued request the page no longer needs (Next, Pause, Exit) before it
  is sent.

## Listen & Learn

Tap **🎧 Listen & Learn**, put the phone down, and listen. Nothing is asked and
the microphone is never used. The teacher teaches each word, then goes on to the
next word by itself, like a personal medical-Chinese podcast. For every word:

1. **a Mandarin introduction**: "我们来学一个医学词语：硬膜外。";
2. **the term**, slowly (`硬膜外`), with the **pinyin on screen** (`yìng mó wài`).
   Pinyin is never sent to the voice: the Mandarin voice says the characters;
3. **the English and a short explanation**: what the term means in medical
   communication, built on the JH Medics meaning, then **practical usage**:
   where and how the term is actually used (which
   situations, departments, conversations);
4. **an example sentence** in Mandarin that uses the **exact** term
   (`医生说我们需要打硬膜外。`);
5. **its English translation**, and a practical situation where an interpreter
   hears or needs the term;
6. when it helps, **a short doctor/patient/nurse/interpreter exchange**, in
   Mandarin, then in English;
7. **a Mandarin recap**: "再听一次：硬膜外。<the example sentence>".

This is 6 to 8 natural audio segments per word, each generated once (6 to 8
Qwen TTS requests the first time; cached afterwards).

- **Where the content comes from:** the term, pinyin, English, meaning and order
  come from JH Medics Volume 1 and are never changed. JH Medics has no
  explanations or example sentences, so the Qwen teacher writes items 3-7 (the
  explanation, usage, sentence, translation, situation and dialogue), once per
  word, server-side, from that entry only (`src/listencontent.js`). The page
  labels them "Explanation and examples by the AI teacher", never as JH Medics.
- **Checks on the teacher's material:** the sentence must contain the exact
  term, character for character, be short, and be Mandarin only; the English
  parts must be English only. An invalid reply gets one correction round. A
  dialogue that fails its checks is dropped (the lesson plays without it).
- **Storage and fallback:** good material is stored (`listen_content`) and reused.
  If Qwen fails or is unavailable, a plain template (the JH Medics meaning, and a
  simple sentence with the exact term) is used and not stored, so Qwen is asked
  again next time. Material stored by an older version is rewritten once.
- **Interactive Practice** gets the same material: the teacher uses the stored
  sentence and dialogue when it teaches practical usage and starts the role-play.

Controls: **▶ Play / ⏸ Pause** (Play resumes the interrupted step), **↻ Repeat**
(the current word's lesson again), **→ Next** (optional: skip ahead now),
**Exit Listen Mode**. The next lesson's text is fetched while the current one
plays. Audio is generated line by line as it is played (one line ahead), each
line only once: Pause, Resume and Repeat reuse the audio the page already has,
and audio still arriving after Next is never played.

Play is continuous. When the last line of a word's audio has played to its end
(the audio `ended` event, not a timer), that word is recorded as completed and,
after a short pause, the next one starts by itself. The status line shows
"Word 1 complete. Moving to Word 2…". There is no "press Next" step: Next is
only there to skip. Pause, Repeat and loading never complete or advance
anything; Next skips a word without completing it.

The line above the lesson says which word is playing and how it relates to your
place: "Now teaching: Word 2 of 385", or after a skip "Now playing: Word 3 of 385,
ahead of your place · your place stays at Word 1 (skipped, not completed yet)".
The Progress line always shows your one shared place.

If a line's audio cannot be played (Qwen TTS failed, network), the player stops
on that line: "Word 1: this line's audio could not be played, so Word 1 is not
complete. ▶ Play tries again · → Next skips it." ▶ Play asks Qwen for that line
again and carries on. If a finished word cannot be saved, the player also stops
and ▶ Play saves it.

A clip only counts as finished when the audio element has really played to its
end (`ended` while the element holds that clip). Duplicate, stray or late
`ended` events, and anything from a clip that Pause, Repeat, Next or Exit
cancelled, are ignored, so nothing can skip a clip or a word.

The page shows its version under the title ("Version 1.1.0 (commit 1a2b3c4)")
and at the bottom. `https://localhost:3443/api/version` returns the same version
and commit, and the server prints them at startup together with the folder it
serves the page from. If the page and the server differ, a notice says so.

**Updating (Windows):** double-click **`update-tutor.cmd`** in `roy-tutor`. It
puts aside local changes git would otherwise refuse (usually `package-lock.json`
after `npm install`), switches to the latest version, runs `npm install` and
prints the version. `.env` and `tutor.db` (your progress) are not touched. Then
close any old tutor window and double-click `start-tutor.cmd`. If an old server
is still running, the new one says "Port 3443 is already in use: another Roy
tutor server (probably an older version) is still running" instead of starting.

On a new study day, Listen & Learn first plays short reviews of the previous
day's words (word, pinyin, English, sentence, translation, word), once per day,
then continues with Roy's current word.

## Progress and review (shared by both modes)

There is one position in JH Medics Volume 1, word 1 → 385, shared by both modes.

- **Interactive Practice** completes a word when all four exercises are done.
- **The place** is always the first word, in book order, that is not completed.
- **Listen & Learn** completes a word when every segment of its lesson has
  played to the end (the audio `ended` event). The page reports this
  (`POST /api/listen/complete`). Completing the word at the place moves the place
  on, in both modes, past any words already completed. If today's Interactive
  session was on that word, it moves on too.
- **No false completion:** fetching a lesson or starting its audio changes
  nothing. A lesson that was skipped, interrupted or had a failed audio step is
  not counted.
- **No accidental skipping:** a word skipped with **Next** is not completed, and
  the place stays on it. Words heard in full after a skip are completed, but the
  place does not move past the skipped word until it is completed. Earlier words
  and review lessons are only logged (`listen_log`).
- **A new study day** (by `TUTOR_TIMEZONE`): Interactive Practice starts with
  "Welcome back, Roy. Yesterday we studied …" and reviews those words, including
  words learnt by listening, plus up to 5 weak words. A missed word is marked weak
  and asked again once. Listening never counts as the day's Interactive session,
  so listening first does not skip this review.
- **Resuming:** the same day resumes the open session. A browser refresh or
  reconnect picks up from the server's saved state.
- **Side trips:** "go to word 12" is temporary and keeps Roy's place.

An entry is marked weak if Roy gave two or more wrong answers or needed help
twice on it.

## When things go wrong

| Situation | What happens |
|---|---|
| Microphone blocked / missing / busy | a clear message; the type-instead box opens |
| ASR fails or hears nothing | nothing counted; **↻ RETRY** resends the recording, or say it again |
| TTS fails | Interactive: the teacher's text is shown and the lesson carries on. Listen & Learn: stops on that line with a message, the word is not completed, ▶ Play asks Qwen for the line again |
| Qwen teacher slow or unreachable | request timeout (`QWEN_TIMEOUT_MS`), one retry, then "took too long … nothing was counted" |
| Qwen teacher reply malformed | repaired when possible, otherwise one corrected retry, then "unusable reply … nothing was counted" |
| Network drop / phone reconnect | Interactive: "can't reach the tutor server", the answer is not counted. Listen & Learn pauses at the same step; ▶ Play retries |
| Audio playback blocked by the phone | "tap once to allow sound"; Listen & Learn pauses |
| Browser refresh | progress and today's session come back from the server |

Progress is only written by the engine after a successful turn or a finished
Listen lesson. A failed request never changes it.

## Tests

`npm test` runs the whole suite offline. Qwen is replaced by local stand-in
servers that check every request. The tests cover:

- **AI teacher:** request format, schema repair and retry, malformed replies,
  timeouts, natural answers.
- **Evaluation:** the ASR-aware levels (膜/磨).
- **Progress:** sequential order, completion, resume, review, the shared position,
  no false completion.
- **Listen & Learn:** every section for all 385 words, validated examples and
  fallback, auto-advance, Next, Repeat, Pause/Resume, network pause. Continuous
  play is also tested against the real server (`test/listen-flow.test.js`) and in
  real Chromium (`test/browser.test.js`). It clicks Listen & Learn once and
  expects Word 1 → 2 → 3 with no further clicks, the real audio `ended` events
  and the progress line following. It also covers Pause, Resume, Repeat, Next,
  an audio failure and its retry, the whole sequence ending in Interactive
  Practice at the same place, and a spoken answer through Chromium's fake
  microphone (recording → 16 kHz WAV → server → ASR → evaluation → teacher →
  TTS → playback, no browser speech engines, the key never sent to the page).
  On a failure it prints the browser's timeline. It is skipped only if
  Playwright is not installed.
- **Voice:** ASR and TTS requests, server-side audio, no browser speech APIs, the
  key never reaching the browser.
- **Phone:** HTTPS certificates, LAN binding, the setup page, the access code.

`npm run check-voice` is the real-Qwen check: it prints the ASR/TTS models,
endpoints, HTTP statuses and transcript.

## Layout

```
server.js              HTTP(S) server and JSON API
scripts/start-https.mjs  npm run start:https (development certificate + setup page)
src/tutor.js           tutor engine: order, exercises, review, progress (both modes)
src/teacher.js         the AI teacher (Qwen chat, server side)
src/evaluation.js      ASR-aware answer evaluation (same sound vs same character)
src/voice.js           Qwen ASR and TTS (server side)
src/listen.js          Listen & Learn lesson script
src/listencontent.js   Listen & Learn examples written by the teacher (checked, stored)
src/recognition.js     pinyin helpers; pronunciation-scoring hook
src/devcert.js, src/devsetup.js  development certificates and the phone setup page
src/env.js             .env loading
src/db.js              SQLite schema and queries
src/curriculum.js, src/intents.js, src/match.js, src/network.js  curriculum import, jumps, text helpers, LAN addresses
data/                  JH Medics Volume 1 (see data/README.md)
public/                the page: records audio, plays the teacher's audio
test/                  npm test
```

Database tables: `courses`, `curriculum`, `user_progress` (current position,
last study date, last session, review due), `entry_progress` (completed,
practised, confidence, weak), `study_sessions` (Interactive sessions: words
studied/reviewed, weak words, summary, lesson state), `listen_content`
(teacher-written Listen & Learn material) and `listen_log` (finished Listen
lessons by date), `listen_state` (the day's Listen review).

## Courses: one teacher, any document

The teaching is the same code for every course: the Qwen teacher
(`src/teacher.js`), the lesson writer (`src/listencontent.js`), the Listen &
Learn lesson (`src/listen.js`), Interactive Practice, correction, role-play
and the new-day review. A course document only supplies the items (a word,
phrase or sentence), their pinyin, English and meaning, and their order. If a
document gives little (only `硬膜外 yìng mó wài epidural`), the teacher still
teaches it fully: explanation, practical usage, example sentence, translation,
medical and interpreter situation, dialogue. That material is generated, kept
separate, and labelled as the AI teacher's, never as the document's.

**Add a course** (in `roy-tutor`, with the tutor stopped):

```
npm run course -- add "C:\path\to\JH Medics Volume 2.docx" --title "JH Medics Volume 2"
npm run course -- list
npm run course -- activate jh-medics-volume-2
```

- `add` reads the document, shows how many items it found (and the first ones),
  saves it as `data/<id>.json`, lists it in `data/courses.json` and loads it.
  It is **waiting**, not active: the course being studied never changes by
  itself. Add `--activate` to switch at once.
- `activate` makes one course the active one. Every course keeps its own place
  and progress; switching back continues where you stopped.
- Documents it reads: **.docx** (a table with one item per row, in any column
  order, with or without headers; or one item per paragraph), **.txt** (one item
  per line: `挂号 guà hào register: meaning`), **.csv / .tsv**, **.json**. A
  **.pdf** cannot be read reliably: open it in Word, save as .docx, add that.
- The same reader rebuilds JH Medics Volume 1 from its original Word file
  exactly (385 of 385 entries; a test checks this).
- Nothing in a document is corrected or invented. A missing pinyin, English or
  meaning stays missing (the page says "no pinyin in the source"), and `add`
  reports how many are missing.

## Curriculum

All 385 entries of JH Medics Volume 1 are loaded from the source Word document,
in book order, with page numbers. See [`data/README.md`](data/README.md) for how
they were extracted and checked. Volume 2 is not loaded.

// Voice loop. The microphone button drives everything:
//
//   IDLE → (tap) → TEACHER THINKING → TEACHER SPEAKING → LISTENING
//        → AUDIO CAPTURED → TRANSCRIPT RECEIVED → TEACHER THINKING
//        → PREPARING TEACHER VOICE → TEACHER AUDIO READY → TEACHER SPEAKING → LISTENING …
//
// The page records Roy's answer and uploads it; the server has Qwen turn it
// into text, and the text goes to the tutor exactly like a typed answer. The
// teacher's replies come back as Qwen audio from the server. The browser's own
// speech recognition and speech synthesis are not used. No API keys live here.

import {
  recognitionLang, LANGUAGE_LABEL, otherLanguage, lessonStateText, friendlyError, VOICE_ERRORS,
  STATES, BUSY_STATES, pickRecorderType, uploadType, toMono, resample, encodeWav, silentWav,
  SilenceDetector, rms, lineText, playbackRate, ListenController, listenStatusText, CLIENT_VERSION,
} from './voice-core.js';

const $ = (id) => document.getElementById(id);
const talkBtn = $('talk');
const retryBtn = $('retry');
const micStateEl = $('mic-state');
const statusEl = $('status');
const heardEl = $('heard');
const logEl = $('log');
const lessonEl = $('lesson-state');
const micLangBtn = $('mic-lang');

const CAN_RECORD = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
const ASR_RATE = 16000;

let state = 'idle';
let sessionOpen = false; // the tutor has asked something and is waiting for an answer
let listenLang = null; // the language the lesson expects next (from the server)
let langOverride = null; // Roy switched the answer language for this turn
let mode = null;
let turnsHeard = 0;
let silentRetries = 0;
let speechRun = 0; // bumps to cancel teacher audio in progress
let lastRecording = null; // kept so a failed transcription can be retried
let voiceWarned = false;

// Short pauses so each step is visible on the badge.
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function accessHeaders() {
  let code = '';
  try { code = localStorage.getItem('tutorAccessCode') || ''; } catch { /* storage unavailable */ }
  return code ? { 'X-Access-Code': code } : {};
}

// fetch with the access code; asks for the code once on 401.
async function request(url, init = {}) {
  let res;
  try {
    res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), ...accessHeaders() } });
  } catch (err) {
    throw Object.assign(new TypeError(err.message || 'Failed to fetch'), { code: 'network' });
  }
  if (res.status === 401) {
    const code = prompt('Access code');
    if (code) {
      try { localStorage.setItem('tutorAccessCode', code); } catch { /* ignore */ }
      return request(url, init);
    }
  }
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw Object.assign(new Error(info.error || res.statusText), { code: info.code ?? (res.status >= 500 ? 'server_error' : null), status: res.status });
  }
  return res;
}

async function api(method, url, body) {
  const res = await request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ---------- display ----------

function setState(next, { again = false } = {}) {
  state = next;
  const s = STATES[next];
  micStateEl.dataset.state = next;
  micStateEl.textContent = next === 'listening' && again ? 'LISTENING AGAIN' : s.badge;
  talkBtn.dataset.state = next;
  talkBtn.textContent = s.button;
  talkBtn.setAttribute('aria-pressed', String(next !== 'idle'));
  statusEl.classList.toggle('listening', next === 'listening');
  if (next !== 'idle') retryBtn.hidden = true;
}

function setStatus(text) { statusEl.textContent = text; }

function showHeard(text) {
  heardEl.hidden = !text;
  heardEl.textContent = text ? `You said: “${text}”` : '';
}

function micLang() {
  return langOverride ?? listenLang;
}

function hintFor(lang) {
  if (mode === 'pronunciation') return 'Say the Mandarin term.';
  return lang?.startsWith('zh') ? 'Answer in Mandarin.' : 'Answer in English, in your own words.';
}

function renderMicLang() {
  const lang = micLang();
  micLangBtn.hidden = !sessionOpen || !lang;
  if (!lang) return;
  micLangBtn.textContent = `Answer language: ${LANGUAGE_LABEL[lang]} · switch to ${LANGUAGE_LABEL[otherLanguage(lang)]}`;
  micLangBtn.setAttribute('aria-pressed', String(Boolean(langOverride)));
}

function addLog(who, text) {
  const p = document.createElement('p');
  p.className = who;
  p.textContent = text;
  logEl.append(p);
  logEl.scrollTop = logEl.scrollHeight;
}

function renderStatus(status) {
  if (!status?.course) return;
  if (status.course.title) $('course').textContent = status.course.title.toUpperCase();
  $('progress').textContent = status.finished
    ? `Progress: all ${status.total} words complete`
    : `Progress: Word ${status.position} of ${status.total}`;
}

function renderView(view) {
  lessonEl.textContent = lessonStateText(view);
  for (const li of document.querySelectorAll('#stages li')) {
    li.classList.toggle('active', li.dataset.stage === view.stage);
  }
  const card = view.card;
  $('card').hidden = !card;
  if (!card) return;
  $('card-position').textContent = `Word ${card.position}${card.sourcePage ? ` · page ${card.sourcePage}` : ''}`;
  $('card-mandarin').textContent = card.mandarin ?? '？';
  $('card-pinyin').textContent = card.pinyin ?? '';
  $('card-english').textContent = card.english ?? '？';
  $('card-meaning').textContent = card.meaning ?? (card.english ? 'JH Medics meaning not loaded yet' : '');
  const tag = view.jump ? 'Side trip: your curriculum place is saved' : view.stage === 'conversation' ? `Role-play: you are the ${view.role.toLowerCase()}` : '';
  $('card-tag').textContent = tag;
  $('card-tag').hidden = !tag;
}

function noteOnce(message) {
  if (voiceWarned) return;
  voiceWarned = true;
  addLog('note', message);
}

// ---------- teacher audio (Qwen TTS, played from the server) ----------

// One audio element for the whole session. iPhone Safari only lets a page
// play sound after a tap; playing a silent clip on each tap keeps this
// element allowed to play the teacher's audio later.
const player = new Audio();
player.preload = 'auto';
let silentUrl = null;

function unlockAudio() {
  try {
    silentUrl ??= URL.createObjectURL(new Blob([silentWav()], { type: 'audio/wav' }));
    if (player.paused) {
      player.src = silentUrl;
      player.play().catch(() => { /* reported later if it matters */ });
    }
  } catch { /* ignore */ }
  audioContext()?.resume?.().catch(() => {});
}

async function fetchAudio(id) {
  const res = await request(`/api/voice/speech/${encodeURIComponent(id)}`);
  return URL.createObjectURL(await res.blob());
}

// Plays one clip on the shared <audio> element. A clip only ever handles its
// own events and pauses the element only while it still holds this clip: a
// cancelled clip (Pause, Repeat, Next) must not stop or unhook the next one.
function playUrl(url, rate, run) {
  return new Promise((resolve, reject) => {
    const mine = () => player.src === url;
    const cancel = setInterval(() => { if (run !== speechRun) { if (mine()) player.pause(); finish(); } }, 150);
    const onEnded = () => { if (mine()) finish(); };
    const onError = () => { if (mine()) fail(Object.assign(new Error('The teacher audio could not be played.'), { code: 'tts_failed' })); };
    function cleanup() {
      clearInterval(cancel);
      player.removeEventListener('ended', onEnded);
      player.removeEventListener('error', onError);
    }
    function finish() { cleanup(); resolve(); }
    function fail(err) { cleanup(); reject(err); }
    player.addEventListener('ended', onEnded);
    player.addEventListener('error', onError);
    player.src = url;
    player.playbackRate = rate;
    player.play().catch((err) => {
      // (also when another clip replaced this one before it started: never counted as played)
      fail(Object.assign(new Error(err?.message || 'playback failed'), { code: err?.name === 'NotAllowedError' ? 'play-blocked' : 'tts_failed' }));
    });
  });
}

// Shows the teacher's reply, then plays each line's Qwen audio in order.
// Returns true if it finished (not interrupted by a tap or blocked).
async function speakAll(segments) {
  if (!segments.length) return true;
  addLog('tutor', segments.map(lineText).join(' '));
  const run = ++speechRun;
  const lines = segments.filter((s) => s.audio);
  if (!lines.length) {
    noteOnce('No teacher audio for this reply (Qwen voice is not configured on the server). Read the replies here.');
    return true;
  }
  setState('preparing');
  setStatus("Preparing the teacher's voice (Qwen)…");
  // The server is already producing every line: fetch them all, play in order.
  const jobs = lines.map((s) => fetchAudio(s.audio).then((url) => ({ url }), (err) => ({ err })));
  let failed = null;
  for (let i = 0; i < lines.length; i += 1) {
    const got = await jobs[i];
    if (run !== speechRun) break;
    if (got.err) { failed ??= got.err; continue; }
    if (state === 'preparing') {
      setState('ready');
      setStatus('Teacher audio ready.');
      await pause(300);
      if (run !== speechRun) break;
    }
    setState('speaking');
    setStatus('Tap the button to skip ahead and answer.');
    try {
      await playUrl(got.url, playbackRate(lines[i]), run);
    } catch (err) {
      failed ??= err;
      if (err.code === 'play-blocked') break;
    }
  }
  Promise.all(jobs).then((all) => all.forEach((r) => r.url && URL.revokeObjectURL(r.url)));
  if (failed) {
    console.error('[voice] teacher audio failed:', failed);
    addLog('note', friendlyError(failed));
    if (failed.code === 'play-blocked') { setState('idle'); setStatus(VOICE_ERRORS['play-blocked']); return false; }
  }
  return run === speechRun;
}

function stopSpeaking() {
  speechRun += 1;
  if (!player.paused) player.pause();
}

// ---------- Roy's answer (recorded here, recognised by Qwen on the server) ----------

let micStream = null;
let ctx = null;

function audioContext() {
  if (!ctx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) ctx = new Ctx();
  }
  return ctx;
}

// The microphone stays open for the session, so later answers need no tap
// and no new permission prompt.
async function openMic() {
  if (micStream?.getAudioTracks().some((t) => t.readyState === 'live')) return micStream;
  micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  return micStream;
}

function releaseMic() {
  micStream?.getTracks().forEach((t) => t.stop());
  micStream = null;
}

function micErrorCode(err) {
  if (err?.name === 'NotAllowedError' || err?.name === 'SecurityError') return 'not-allowed';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'no-mic';
  if (err?.name === 'NotReadableError' || err?.name === 'AbortError') return 'mic-busy';
  return 'unsupported';
}

let recording = null; // { stop(reason) } while LISTENING

// Records until Roy stops talking or taps DONE TALKING. Resolves with
// { blob, type, spoke, reason }: spoke is false if no speech was detected;
// reason 'cancel' means the recording was abandoned.
function record(stream) {
  return new Promise((resolve, reject) => {
    const type = pickRecorderType(window.MediaRecorder.isTypeSupported?.bind(window.MediaRecorder));
    let rec;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); } catch (err) { reject(err); return; }
    const chunks = [];
    const detector = new SilenceDetector();
    let spoke = false;
    let endReason = null;
    let analyser = null;
    let source = null;
    const ac = audioContext();
    if (ac) {
      try {
        source = ac.createMediaStreamSource(stream);
        analyser = ac.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
      } catch { analyser = null; }
    }
    const buf = new Float32Array(2048);
    const tick = setInterval(() => {
      if (!analyser) return;
      analyser.getFloatTimeDomainData(buf);
      const verdict = detector.feed(rms(buf), performance.now());
      if (verdict === 'speech') { spoke = true; setStatus('Hearing you… pause when you finish, or tap DONE TALKING.'); }
      if (verdict === 'done' || verdict === 'nothing') finish(verdict);
    }, 100);
    // Hard stop, also when level detection is unavailable.
    const cap = setTimeout(() => finish('max'), 31000);
    const result = () => ({ blob: new Blob(chunks, { type: rec.mimeType || type }), type: rec.mimeType || type, spoke, reason: endReason });
    function finish(reason) {
      if (endReason) return;
      endReason = reason;
      if (recording?.stop === finish) recording = null;
      clearInterval(tick);
      clearTimeout(cap);
      try { source?.disconnect(); } catch { /* ignore */ }
      // A tap or the time limit sends what was recorded, even if the level
      // detector missed the speech (for example a very quiet voice).
      if (reason === 'tap' || reason === 'max') spoke = true;
      if (reason === 'nothing' || reason === 'cancel') spoke = false;
      if (rec.state !== 'inactive') rec.stop();
      else resolve(result());
    }
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    rec.onstop = () => { endReason ??= 'stopped'; resolve(result()); };
    rec.onerror = (e) => { finish('cancel'); reject(e.error ?? new Error('recorder error')); };
    rec.start();
    recording = { stop: finish };
  });
}

// The phone's recording (mp4 on iPhone, webm elsewhere) → 16 kHz mono WAV,
// which Qwen accepts everywhere. If the browser can't decode its own
// recording, the original is uploaded instead.
async function toWav(blob) {
  const ac = audioContext();
  if (!ac) return null;
  try {
    const data = await blob.arrayBuffer();
    const decoded = await new Promise((resolve, reject) => {
      const p = ac.decodeAudioData(data, resolve, reject);
      p?.then?.(resolve, reject);
    });
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i));
    const samples = resample(toMono(channels), decoded.sampleRate, ASR_RATE);
    return new Blob([encodeWav(samples, ASR_RATE)], { type: 'audio/wav' });
  } catch (err) {
    console.warn('[voice] could not convert the recording to WAV; uploading it as recorded', err);
    return null;
  }
}

async function transcribe(upload) {
  const res = await request(`/api/voice/transcribe?lang=${encodeURIComponent(upload.lang)}`, {
    method: 'POST',
    headers: { 'Content-Type': upload.type },
    body: upload.blob,
  });
  return res.json();
}

function openTypeFallback(message) {
  document.querySelector('.type-instead').open = true;
  setState('idle');
  setStatus(message);
}

async function listen() {
  const lang = micLang();
  if (!sessionOpen || !lang) { setState('idle'); setStatus('Tap START TALKING to continue.'); return; }
  if (!window.isSecureContext) { openTypeFallback(VOICE_ERRORS['insecure-context']); return; }
  if (!CAN_RECORD) { openTypeFallback(VOICE_ERRORS.unsupported); return; }
  let stream;
  try {
    stream = await openMic();
  } catch (err) {
    console.error('[voice] microphone failed:', err);
    const code = micErrorCode(err);
    if (code === 'mic-busy') { setState('idle'); setStatus(VOICE_ERRORS[code]); } else openTypeFallback(VOICE_ERRORS[code]);
    return;
  }
  setState('listening', { again: turnsHeard > 0 });
  showHeard('');
  setStatus(`Listening (${LANGUAGE_LABEL[lang]}). ${langOverride ? 'Switched for this answer only. ' : ''}${hintFor(lang)} Tap DONE TALKING when you finish.`);
  let rec;
  try {
    rec = await record(stream);
  } catch (err) {
    console.error('[voice] recording failed:', err);
    setState('idle');
    setStatus(VOICE_ERRORS['mic-busy']);
    return;
  }
  if (rec.reason === 'cancel') return; // switched language, or a typed answer took over
  if (!rec.spoke || !rec.blob.size) {
    if (silentRetries < 1) { silentRetries += 1; listen(); return; }
    setState('idle');
    setStatus(VOICE_ERRORS['no-speech']);
    return;
  }
  silentRetries = 0;
  setState('captured');
  setStatus('Got your answer. Sending it to Qwen speech recognition…');
  const wav = await toWav(rec.blob);
  lastRecording = wav ? { blob: wav, type: 'audio/wav', lang } : { blob: rec.blob, type: uploadType(rec.type), lang };
  await recognise(lastRecording);
}

async function recognise(upload) {
  setState('captured');
  setStatus('Sending your answer to Qwen speech recognition…');
  let result;
  try {
    result = await transcribe(upload);
  } catch (err) {
    console.error('[voice] transcription failed:', err);
    if (err.code === 'ai_not_configured') { openTypeFallback(friendlyError(err)); return; }
    setState('idle');
    setStatus(friendlyError(err));
    // The same recording can be sent again when the service failed; a
    // recording with no words needs a new one.
    retryBtn.hidden = !['asr_failed', 'network', 'server_error'].includes(err.code);
    return;
  }
  lastRecording = null;
  turnsHeard += 1;
  setState('transcribed');
  showHeard(result.text);
  setStatus('Transcript received.');
  await pause(700);
  // The transcript goes to the tutor exactly like a typed answer.
  await send(result.text, { source: 'voice', language: result.language ?? upload.lang });
}

function stopListening() {
  recording?.stop('cancel');
}

// ---------- flow ----------

async function handle(result) {
  if (result.status) renderStatus(result.status);
  renderView(result);
  listenLang = result.listen;
  langOverride = null;
  mode = result.mode;
  sessionOpen = !result.ended;
  renderMicLang();
  const finished = await speakAll(result.say || []);
  if (result.ended) {
    releaseMic();
    setState('idle');
    setStatus('Session saved. See you next time.');
    return;
  }
  if (finished) listen();
}

async function send(text, meta = { source: 'text' }) {
  if (state === 'processing') return;
  stopListening();
  stopSpeaking();
  addLog('roy', text);
  setState('processing');
  setStatus('The teacher is thinking…');
  try {
    const result = await api('POST', '/api/session/message', { text, ...meta });
    await handle(result);
  } catch (err) {
    console.error('[tutor] message failed:', err);
    setState('idle');
    setStatus(`${friendlyError(err)} That answer was not counted; tap START TALKING and say it again.`);
    renderMicLang();
  }
}

async function startSession() {
  setState('processing');
  setStatus('Starting…');
  try {
    await handle(await api('POST', '/api/session/start'));
  } catch (err) {
    console.error('[tutor] start failed:', err);
    setState('idle');
    setStatus(friendlyError(err));
  }
}

talkBtn.addEventListener('click', () => {
  unlockAudio();
  if (BUSY_STATES.has(state)) return;
  if (state === 'speaking' || state === 'ready') { stopSpeaking(); listen(); return; }
  if (state === 'listening') { recording?.stop('tap'); return; }
  silentRetries = 0;
  if (sessionOpen && listenLang) listen();
  else startSession();
});

retryBtn.addEventListener('click', () => {
  unlockAudio();
  if (lastRecording && !BUSY_STATES.has(state)) recognise(lastRecording);
});

// The lesson picks the answer language (Qwen gets it as a hint). Roy can
// switch it for one answer; the next teacher reply resets it.
micLangBtn.addEventListener('click', () => {
  langOverride = langOverride ? null : otherLanguage(listenLang);
  renderMicLang();
  if (state === 'listening') { stopListening(); listen(); }
  else setStatus(`Answer language set to ${LANGUAGE_LABEL[micLang()]} (${recognitionLang(micLang())})${langOverride ? ' for this answer only' : ''}.`);
});

for (const btn of document.querySelectorAll('.quick button')) {
  btn.addEventListener('click', () => {
    unlockAudio();
    if (!sessionOpen) { startSession(); return; }
    send(btn.dataset.say);
  });
}

$('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  unlockAudio();
  const text = $('type-input').value.trim();
  if (!text) return;
  $('type-input').value = '';
  if (!sessionOpen) { startSession(); return; }
  send(text, { source: 'text' });
});

setState('idle');
renderMicLang();
if (!window.isSecureContext) {
  // Browsers only allow the microphone on https:// or localhost.
  document.querySelector('.type-instead').open = true;
  setStatus(VOICE_ERRORS['insecure-context']);
} else if (!CAN_RECORD) {
  document.querySelector('.type-instead').open = true;
  setStatus(VOICE_ERRORS.unsupported);
}
// ---------- choosing a mode: Interactive Practice or Listen & Learn ----------
//
// Both modes share Roy's curriculum position (JH Medics word 1 → 385).

let learnMode = null; // null (home), 'interactive' or 'listen'
// Latest from the server's completion replies (lessons are fetched ahead, so
// the numbers inside a lesson can be one word behind).
let listenedWords = null;
let latestPosition = null;

function notice(text) {
  $('notice').textContent = text || '';
  $('notice').hidden = !text;
}

function showMode(next) {
  learnMode = next;
  $('interactive').hidden = next !== 'interactive';
  $('listen').hidden = next !== 'listen';
  $('mode-interactive').setAttribute('aria-pressed', String(next === 'interactive'));
  $('mode-listen').setAttribute('aria-pressed', String(next === 'listen'));
}

// Home: the progress line and Roy's current word (text only, nothing generated).
async function showHome() {
  try {
    const s = await api('GET', '/api/status');
    renderStatus(s);
    $('version').textContent = `v${CLIENT_VERSION}`;
    if (s.version && s.version !== CLIENT_VERSION) {
      notice(`This page (v${CLIENT_VERSION}) and the server (v${s.version}) are different versions. Stop the server, run "git pull" and "npm install", start it again, then reload this page.`);
      return;
    }
    if (s.aiConfigured === false) {
      const msg = 'Qwen is not configured: DASHSCOPE_API_KEY is missing. Set it in roy-tutor/.env on the server and restart the server.';
      setStatus(msg);
      notice(msg);
    }
    if (!s.course) return;
    const lesson = await api('GET', `/api/listen?audio=0&position=${Math.min(s.position, s.total)}`);
    renderView({ card: lesson.card, stage: null });
  } catch (err) {
    notice(friendlyError(err));
  }
}

// Stop everything Interactive Practice is doing (the microphone is released).
function leaveInteractive() {
  stopListening();
  stopSpeaking();
  releaseMic();
  setState('idle');
}

$('mode-interactive').addEventListener('click', () => {
  unlockAudio();
  if (learnMode === 'listen') listenPlayer.exit();
  notice('');
  showMode('interactive');
  // Start, or resume today's session (Listen & Learn may have moved the word on).
  if (!BUSY_STATES.has(state) && state !== 'listening' && state !== 'speaking') startSession();
});

$('mode-listen').addEventListener('click', () => {
  unlockAudio(); // this tap lets iPhone Safari play the lesson audio
  leaveInteractive();
  notice('');
  showMode('listen');
  latestPosition = null; // Interactive Practice may have moved it
  if (listenPlayer.state === 'idle') listenPlayer.open(undefined); // the server picks: review first on a new day, else the current word
  else listenPlayer.play();
});

// ---------- Listen & Learn: Qwen TTS lessons, no microphone ----------

const readingTime = (step) => 1500 + String(step.show || step.text).length * 60;

// One step: fetch its Qwen audio from the server and play it. When there is no
// audio (TTS failed or not configured) the text stays on screen for reading
// time, and the step counts as failed, so the word is not marked as listened.
async function playListenStep(step) {
  const run = speechRun;
  let url;
  try {
    if (!step.audio) throw Object.assign(new Error('No teacher audio for this line.'), { code: 'tts_failed' });
    url = await fetchAudio(step.audio);
  } catch (err) {
    if (err.code === 'network') throw err; // the player pauses; Play retries
    await pause(readingTime(step));
    throw err;
  }
  if (run !== speechRun) { URL.revokeObjectURL(url); return; } // paused while the audio was loading
  try {
    await playUrl(url, playbackRate(step), run);
  } finally {
    URL.revokeObjectURL(url);
  }
}

const listenPlayer = new ListenController({
  playStep: playListenStep,
  stopAudio: stopSpeaking,
  loadLesson: (target) => api('GET', target ? `/api/listen?position=${target.position}${target.review ? '&review=1' : ''}` : '/api/listen'),
  onChange: renderListen,
  // Only called when every step of a lesson played. Finishing Roy's current
  // word completes it and moves the shared position on.
  onComplete: async (lesson) => {
    const place = await api('POST', '/api/listen/complete', { position: lesson.position, review: Boolean(lesson.review) });
    listenedWords = place.listened;
    latestPosition = place.currentPosition;
    renderStatus({ course: true, total: place.total, position: place.currentPosition, finished: place.finished });
    renderListen(listenPlayer.view);
  },
  onError: (err) => {
    console.error('[listen]', err);
    if (err?.code === 'play-blocked') notice(VOICE_ERRORS['play-blocked']);
    else if (err?.code === 'network' || err?.name === 'TypeError') notice("Can't reach the tutor server (network). Listening is paused; press ▶ Play when you are connected again.");
    else if (err?.code === 'tts_failed' && listenPlayer.state === 'paused') notice("The teacher's voice (Qwen) is not available right now. Listening is paused; press ▶ Play to try again.");
    else if (err?.code !== 'tts_failed') notice(friendlyError(err));
  },
});

function renderListen(view) {
  const lesson = listenPlayer.lesson;
  if (lesson) {
    renderView({ card: lesson.card, stage: null });
    const what = lesson.review ? `Review ${lesson.reviewIndex + 1} of ${lesson.reviewCount} · Word ${lesson.position}` : `Word ${lesson.position} of ${lesson.total}`;
    const current = latestPosition ?? lesson.currentPosition;
    const place = current && current !== lesson.position && !lesson.review ? ` · your place: Word ${current}` : '';
    const listened = Math.max(listenedWords ?? 0, lesson.listened ?? 0);
    $('listen-where').textContent = `${what}${place} · ${listened} ${listened === 1 ? 'word' : 'words'} listened`;
  }
  const step = view.step;
  const nowEl = $('listen-now');
  nowEl.textContent = step ? step.show || step.text : '';
  nowEl.classList.toggle('zh', step?.lang === 'zh');
  nowEl.lang = step?.lang === 'zh' ? 'zh-CN' : 'en';
  $('listen-source').textContent = step?.source === 'teacher' ? 'Example written by the AI teacher (not from JH Medics)'
    : step?.source === 'template' ? 'Simple example (the AI teacher was unavailable)' : '';
  $('listen-state').dataset.state = view.state;
  $('listen-state').textContent = listenStatusText(view);
  $('listen-play').disabled = view.state === 'playing' || view.state === 'loading';
  $('listen-pause').disabled = !['playing', 'gap', 'loading'].includes(view.state);
  $('listen-repeat').disabled = !lesson || view.state === 'loading';
  $('listen-next').disabled = !view.canNext || view.state === 'loading';
}

$('listen-play').addEventListener('click', () => { unlockAudio(); notice(''); listenPlayer.play(); });
$('listen-pause').addEventListener('click', () => listenPlayer.pause());
$('listen-repeat').addEventListener('click', () => { unlockAudio(); notice(''); listenPlayer.repeat(); });
$('listen-next').addEventListener('click', () => { unlockAudio(); notice(''); listenPlayer.next(); });
$('listen-exit').addEventListener('click', () => {
  listenPlayer.exit();
  showMode(null);
  notice('');
  showHome(); // back to Roy's own place
});

showMode(null);
showHome();

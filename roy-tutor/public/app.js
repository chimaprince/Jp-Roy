// Voice loop. The microphone button drives everything:
//
//   IDLE → (tap) → TEACHER RESPONSE → LISTENING → PROCESSING → TEACHER RESPONSE → LISTENING AGAIN …
//
// Speech is turned into text by the browser's speech recogniser. The text,
// the recogniser's other guesses and its confidence go to the server, where
// the tutor evaluates them. No API keys live here.

import { recognitionLang, LANGUAGE_LABEL, otherLanguage, lessonStateText, speechParts, friendlyError, RECOGNITION_ERRORS, VoiceInput, recognitionStatusText } from './voice-core.js';

const $ = (id) => document.getElementById(id);
const talkBtn = $('talk');
const micStateEl = $('mic-state');
const statusEl = $('status');
const heardEl = $('heard');
const logEl = $('log');
const lessonEl = $('lesson-state');
const micLangBtn = $('mic-lang');
const CAN_SPEAK = 'speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined';

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
// Every recognition event is logged to the browser console as "[speech] ...".
const voice = new VoiceInput(Recognition, { log: (m) => console.log(m) });

const STATES = {
  idle: { badge: 'IDLE', button: '🎙 START TALKING' },
  speaking: { badge: 'TEACHER SPEAKING', button: '🔊 TEACHER SPEAKING' },
  listening: { badge: 'LISTENING', button: '🎙 LISTENING…' },
  processing: { badge: 'THINKING', button: '⏳ THINKING…' },
};

let state = 'idle';
let sessionOpen = false; // the tutor has asked something and is waiting for an answer
let listenLang = null; // the language the lesson expects next (from the server)
let langOverride = null; // Roy switched the microphone language for this turn
let mode = null;
let ttsWarned = false;
let turnsHeard = 0;
let silentRetries = 0;
let speechRun = 0; // bumps to cancel a speech sequence in progress

function accessHeaders() {
  let code = '';
  try { code = localStorage.getItem('tutorAccessCode') || ''; } catch { /* storage unavailable */ }
  return code ? { 'X-Access-Code': code } : {};
}

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
    method,
      headers: { 'Content-Type': 'application/json', ...accessHeaders() },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw Object.assign(new TypeError(err.message || 'Failed to fetch'), { code: 'network' });
  }
  if (res.status === 401) {
    const code = prompt('Access code');
    if (code) {
      try { localStorage.setItem('tutorAccessCode', code); } catch { /* ignore */ }
      return api(method, url, body);
    }
  }
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw Object.assign(new Error(info.error || res.statusText), { code: info.code ?? (res.status >= 500 ? 'server_error' : null), status: res.status });
  }
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
}

function setStatus(text) { statusEl.textContent = text; }

function showHeard(text, final = false) {
  heardEl.hidden = !text;
  heardEl.textContent = text ? `${final ? 'You said' : 'Hearing'}: “${text}”` : '';
}

// The language the microphone uses for the next answer: the lesson's choice,
// unless Roy switched it for this turn.
function micLang() {
  return langOverride ?? listenLang;
}

function listeningHint() {
  const lang = micLang();
  const heardAs = `Mic set to ${LANGUAGE_LABEL[lang] ?? lang} (${recognitionLang(lang)}).`;
  if (langOverride) return `${heardAs} Switched for this answer only.`;
  if (mode === 'pronunciation') return `${heardAs} Say the Mandarin term.`;
  if (lang?.startsWith('zh')) return `${heardAs} Answer in Mandarin.`;
  return `${heardAs} Answer in English, in your own words.`;
}

function renderMicLang() {
  const lang = micLang();
  micLangBtn.hidden = !sessionOpen || !lang;
  if (!lang) return;
  micLangBtn.textContent = `Mic: ${LANGUAGE_LABEL[lang]} · switch to ${LANGUAGE_LABEL[otherLanguage(lang)]}`;
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
  $('course').textContent = status.course.title.toUpperCase();
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

// ---------- speech out ----------

function pickVoice(lang) {
  const voices = speechSynthesis.getVoices();
  const prefix = lang === 'zh' ? 'zh' : 'en';
  return voices.find((v) => v.lang.replace('_', '-') === (lang === 'zh' ? 'zh-CN' : 'en-US'))
    || voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
}

function speakSegment(seg) {
  return new Promise((resolve) => {
    if (!CAN_SPEAK) return resolve();
    const u = new SpeechSynthesisUtterance(seg.text);
    u.lang = seg.lang === 'zh' ? 'zh-CN' : 'en-US';
    const voice = pickVoice(seg.lang);
    if (voice) u.voice = voice;
    u.rate = seg.rate ?? (seg.lang === 'zh' ? 0.85 : 1);
    // Some browsers never fire onend; don't let that stall the conversation.
    const timer = setTimeout(resolve, 2500 + seg.text.length * 180 / u.rate);
    u.onend = () => { clearTimeout(timer); resolve(); };
    u.onerror = (e) => {
      clearTimeout(timer);
      if (!ttsWarned && e.error && e.error !== 'interrupted' && e.error !== 'canceled') {
        ttsWarned = true;
        addLog('note', `The browser could not play the teacher's voice (${e.error}). Read the replies here.`);
      }
      resolve();
    };
    speechSynthesis.speak(u);
  });
}

async function speakAll(segments) {
  addLog('tutor', segments.map((seg) => seg.show ?? seg.text).join(' '));
  if (!CAN_SPEAK) {
    if (!ttsWarned) { ttsWarned = true; addLog('note', "This browser can't speak the teacher's replies. Read them here."); }
    return true;
  }
  const run = ++speechRun;
  setState('speaking');
  setStatus('Tap the button to skip ahead and answer.');
  // Each line is split by script: Chinese characters in a Chinese voice, the rest in English.
  for (const part of segments.flatMap(speechParts)) {
    if (run !== speechRun) return false;
    await speakSegment(part);
  }
  return run === speechRun;
}

function stopSpeaking() {
  speechRun += 1;
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

// ---------- speech in ----------

function openTypeFallback(message) {
  document.querySelector('.type-instead').open = true;
  setState('idle');
  setStatus(message);
}

function listen(waited = 0) {
  const lang = micLang();
  if (!sessionOpen || !lang) { setState('idle'); setStatus('Tap START TALKING to continue.'); return; }
  // Don't open the microphone while the teacher's voice is still playing:
  // the recogniser would hear the teacher instead of Roy.
  if (CAN_SPEAK && speechSynthesis.speaking && waited < 3000) { setTimeout(() => listen(waited + 250), 250); return; }
  if (!window.isSecureContext) { openTypeFallback(RECOGNITION_ERRORS['insecure-context']); return; }
  if (!voice.available) {
    openTypeFallback('Speech recognition is not available in this browser. Use Chrome or Edge for voice, or type your answer below.');
    return;
  }
  const again = turnsHeard > 0;
  setState('listening', { again });
  showHeard('');
  const label = `${LANGUAGE_LABEL[lang] ?? lang} (${recognitionLang(lang)})`;
  voice.listen(lang, {
    onStatus(kind, detail) {
      if (kind === 'interim' || kind === 'final') { showHeard(detail.text, kind === 'final'); return; }
      const text = recognitionStatusText(kind, detail, { language: label });
      if (kind === 'listening' || kind === 'mic-on') setStatus(`${text} ${langOverride ? 'Switched for this answer only.' : hintFor(lang)} Tap the button to pause.`);
      else if (text) setStatus(text);
    },
    onFinal({ text, alternatives, confidence, lang: usedLang }) {
      silentRetries = 0;
      turnsHeard += 1;
      showHeard(text, true);
      send(text, { source: 'voice', alternatives, confidence, language: usedLang });
    },
    onEmpty(reason) {
      // Nothing to send: never post an empty transcript. Retry a couple of times on silence.
      if (reason === 'no-speech' && silentRetries < 2) { silentRetries += 1; listen(3000); return; }
      setState('idle');
      setStatus(reason === 'no-result'
        ? RECOGNITION_ERRORS['no-result']
        : "I didn't hear anything. Check the microphone, then tap START TALKING and speak.");
    },
    onError(code) {
      if (code === 'unavailable') { openTypeFallback('Speech recognition is not available in this browser. Use Chrome or Edge for voice, or type your answer below.'); return; }
      const message = RECOGNITION_ERRORS[code] ?? `Speech recognition stopped with the error "${code}". Tap START TALKING to try again, or type below.`;
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'network'].includes(code)) openTypeFallback(message);
      else { setState('idle'); setStatus(message); }
    },
  });
}

function hintFor(lang) {
  if (mode === 'pronunciation') return 'Say the Mandarin term.';
  return lang?.startsWith('zh') ? 'Answer in Mandarin.' : 'Answer in English, in your own words.';
}

function stopListening() {
  voice.stop();
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
  setStatus('Checking your answer…');
  try {
    const result = await api('POST', '/api/session/message', { text, ...meta });
    showHeard('');
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
  if (state === 'processing') return;
  if (state === 'speaking') { stopSpeaking(); listen(); return; }
  if (state === 'listening') {
    stopListening();
    setState('idle');
    setStatus('Paused. Tap START TALKING to carry on.');
    showHeard('');
    return;
  }
  silentRetries = 0;
  if (sessionOpen && listenLang) listen();
  else startSession();
});

// Chrome listens in one language at a time. When the lesson expects Mandarin
// but Roy wants to say something in English (or the reverse), he switches the
// microphone for this one answer; the next teacher reply resets it.
micLangBtn.addEventListener('click', () => {
  langOverride = langOverride ? null : otherLanguage(listenLang);
  renderMicLang();
  if (state === 'listening') { stopListening(); listen(); }
  else setStatus(listeningHint());
});

for (const btn of document.querySelectorAll('.quick button')) {
  btn.addEventListener('click', () => {
    if (!sessionOpen) { startSession(); return; }
    send(btn.dataset.say);
  });
}

$('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('type-input').value.trim();
  if (!text) return;
  $('type-input').value = '';
  if (!sessionOpen) { startSession(); return; }
  send(text, { source: 'text' });
});

if (CAN_SPEAK) speechSynthesis.getVoices();
setState('idle');
renderMicLang();
if (!window.isSecureContext) {
  // Browsers only allow the microphone on https:// or localhost.
  document.querySelector('.type-instead').open = true;
  setStatus(RECOGNITION_ERRORS['insecure-context']);
} else if (!Recognition) {
  document.querySelector('.type-instead').open = true;
  setStatus('Speech recognition is not available in this browser: use Chrome or Edge for voice, or type below.');
} else {
  // Microphone permission (Chrome supports this query; other browsers may not).
  navigator.permissions?.query({ name: 'microphone' }).then((perm) => {
    const report = () => {
      console.log(`[speech] microphone permission: ${perm.state}`);
      if (perm.state === 'denied') setStatus(RECOGNITION_ERRORS['not-allowed']);
    };
    report();
    perm.onchange = report;
  }).catch(() => { /* permission query not supported: the first listen will tell us */ });
}
api('GET', '/api/status').then((s) => {
  renderStatus(s);
  if (s.session) renderView(s.session);
  if (s.aiConfigured === false) {
    setStatus('Qwen is not configured: DASHSCOPE_API_KEY is missing. Set it in roy-tutor/.env on the server and restart the server.');
  }
}).catch((err) => setStatus(friendlyError(err)));

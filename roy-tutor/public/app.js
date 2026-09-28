// Voice loop. The microphone button drives everything:
//
//   IDLE → (tap) → TEACHER RESPONSE → LISTENING → PROCESSING → TEACHER RESPONSE → LISTENING AGAIN …
//
// Speech is turned into text by the browser's speech recogniser. The text,
// the recogniser's other guesses and its confidence go to the server, where
// the tutor evaluates them. No API keys live here.

const $ = (id) => document.getElementById(id);
const talkBtn = $('talk');
const micStateEl = $('mic-state');
const statusEl = $('status');
const heardEl = $('heard');
const logEl = $('log');

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

const STATES = {
  idle: { badge: 'IDLE', button: '🎙 START TALKING' },
  speaking: { badge: 'TEACHER RESPONSE', button: '🔊 TUTOR SPEAKING' },
  listening: { badge: 'LISTENING', button: '🎙 LISTENING…' },
  processing: { badge: 'PROCESSING', button: '⏳ PROCESSING…' },
};

let state = 'idle';
let sessionOpen = false; // the tutor has asked something and is waiting for an answer
let listenLang = null;
let mode = null;
let recognizer = null;
let turnsHeard = 0;
let silentRetries = 0;
let speechRun = 0; // bumps to cancel a speech sequence in progress

function accessHeaders() {
  let code = '';
  try { code = localStorage.getItem('tutorAccessCode') || ''; } catch { /* storage unavailable */ }
  return code ? { 'X-Access-Code': code } : {};
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', ...accessHeaders() },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    const code = prompt('Access code');
    if (code) {
      try { localStorage.setItem('tutorAccessCode', code); } catch { /* ignore */ }
      return api(method, url, body);
    }
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
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

const LANGUAGE_LABEL = { 'zh-CN': 'Mandarin', 'en-US': 'English' };

function listeningHint() {
  const heardAs = `Listening in ${LANGUAGE_LABEL[listenLang] ?? listenLang} (${recognitionLang(listenLang)}).`;
  if (mode === 'pronunciation') return `${heardAs} Say the Mandarin term.`;
  if (listenLang?.startsWith('zh')) return `${heardAs} Answer in Mandarin.`;
  return `${heardAs} Answer in English, in your own words.`;
}

// The server says which language the answer should be in. Chrome's recogniser
// lists Mandarin as cmn-Hans-CN; other browsers take zh-CN.
function recognitionLang(lang) {
  const isChrome = navigator.userAgentData?.brands?.some((b) => b.brand === 'Google Chrome')
    || (/Chrome\//.test(navigator.userAgent) && !/Edg\//.test(navigator.userAgent));
  return lang === 'zh-CN' && isChrome ? 'cmn-Hans-CN' : lang;
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
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(seg.text);
    u.lang = seg.lang === 'zh' ? 'zh-CN' : 'en-US';
    const voice = pickVoice(seg.lang);
    if (voice) u.voice = voice;
    u.rate = seg.rate ?? (seg.lang === 'zh' ? 0.85 : 1);
    // Some browsers never fire onend; don't let that stall the conversation.
    const timer = setTimeout(resolve, 2500 + seg.text.length * 180 / u.rate);
    u.onend = u.onerror = () => { clearTimeout(timer); resolve(); };
    speechSynthesis.speak(u);
  });
}

async function speakAll(segments) {
  addLog('tutor', segments.map((seg) => seg.show ?? seg.text).join(' '));
  const run = ++speechRun;
  setState('speaking');
  setStatus('Tap the button to skip ahead and answer.');
  for (const seg of segments) {
    if (run !== speechRun) return false;
    await speakSegment(seg);
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

function listen() {
  if (!sessionOpen || !listenLang) { setState('idle'); setStatus('Tap START TALKING to continue.'); return; }
  if (!Recognition) {
    openTypeFallback('This browser has no speech recognition. Type your answer below, or use Chrome or Edge.');
    return;
  }
  const again = turnsHeard > 0;
  recognizer = new Recognition();
  recognizer.lang = recognitionLang(listenLang);
  recognizer.continuous = false;
  recognizer.interimResults = true;
  recognizer.maxAlternatives = 5;
  let finalText = '';
  let alternatives = [];
  let confidence = null;
  let failed = false;

  recognizer.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const result = e.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript;
        confidence = result[0].confidence;
        alternatives = Array.from(result).slice(1).map((a) => a.transcript);
      } else {
        interim += result[0].transcript;
      }
    }
    showHeard((finalText + interim).trim());
  };
  recognizer.onerror = (e) => {
    failed = true;
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      openTypeFallback('Microphone access is blocked. Allow the microphone for this site and tap START TALKING, or type below.');
    } else if (e.error === 'audio-capture') {
      openTypeFallback('No microphone was found. Connect one and tap START TALKING, or type below.');
    } else if (e.error === 'network') {
      openTypeFallback("The browser's speech service can't be reached. Type your answer below for now.");
    } else if (e.error === 'no-speech') {
      failed = false; // handled in onend as a silent turn
    }
  };
  recognizer.onend = () => {
    recognizer = null;
    if (failed || state !== 'listening') return;
    const text = finalText.trim();
    if (text) {
      silentRetries = 0;
      turnsHeard += 1;
      showHeard(text, true);
      send(text, { source: 'voice', alternatives, confidence, language: listenLang });
      return;
    }
    silentRetries += 1;
    if (silentRetries <= 2) { listen(); return; }
    setState('idle');
    setStatus("I didn't hear anything. Tap START TALKING when you're ready.");
  };

  setState('listening', { again });
  setStatus(`${listeningHint()} Tap the button to pause.`);
  showHeard('');
  try {
    recognizer.start();
  } catch {
    recognizer = null;
    setState('idle');
    setStatus('The microphone is busy. Tap START TALKING to try again.');
  }
}

function stopListening() {
  if (!recognizer) return;
  recognizer.onend = null;
  recognizer.onresult = null;
  recognizer.abort();
  recognizer = null;
}

// ---------- flow ----------

async function handle(result) {
  if (result.status) renderStatus(result.status);
  renderView(result);
  listenLang = result.listen;
  mode = result.mode;
  sessionOpen = !result.ended;
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
    setState('idle');
    setStatus(`Problem: ${err.message}. Tap START TALKING to try again.`);
  }
}

async function startSession() {
  setState('processing');
  setStatus('Starting…');
  try {
    await handle(await api('POST', '/api/session/start'));
  } catch (err) {
    setState('idle');
    setStatus(`Problem: ${err.message}`);
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

if ('speechSynthesis' in window) speechSynthesis.getVoices();
setState('idle');
api('GET', '/api/status').then((s) => {
  renderStatus(s);
  if (s.session) renderView(s.session);
  if (s.aiConfigured === false) {
    setStatus('Qwen is not configured: DASHSCOPE_API_KEY is missing. Set it in roy-tutor/.env on the server and restart the server.');
  }
}).catch(() => {});

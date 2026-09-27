// Voice loop: the tutor speaks, then the microphone opens in the language the
// tutor asked for, and whatever Roy says goes back to the server.
// No API keys live here; all AI calls happen on the server.

const $ = (id) => document.getElementById(id);
const talkBtn = $('talk');
const statusEl = $('status');
const logEl = $('log');

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let active = false;
let recognizer = null;
let listenLang = null;
let busy = false;
let silentRetries = 0;

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

function setStatus(text, listening = false) {
  statusEl.textContent = text;
  statusEl.classList.toggle('listening', listening);
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
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

async function speakAll(segments) {
  const lines = [];
  for (const seg of segments) lines.push(seg.show ?? seg.text);
  addLog('tutor', lines.join(' '));
  setStatus('Tutor is speaking…');
  for (const seg of segments) {
    if (!active) break;
    await speakSegment(seg);
  }
}

// ---------- speech in ----------

function listen() {
  if (!active || !listenLang) { setStatus(active ? 'Say something, or use a button below.' : 'Paused.'); return; }
  if (!Recognition) { setStatus('This browser cannot hear you. Use Chrome or Edge, or type below.'); return; }
  recognizer = new Recognition();
  recognizer.lang = listenLang;
  recognizer.interimResults = false;
  recognizer.maxAlternatives = 1;
  let heard = false;
  recognizer.onresult = (e) => {
    heard = true;
    silentRetries = 0;
    send(e.results[0][0].transcript);
  };
  recognizer.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      stopTalking();
      setStatus('Microphone blocked. Allow microphone access, then press the button again.');
    }
  };
  recognizer.onend = () => {
    recognizer = null;
    if (!heard && active && !busy) {
      silentRetries += 1;
      if (silentRetries <= 3) listen();
      else setStatus('Still here. Press the button when you are ready.');
    }
  };
  setStatus(listenLang.startsWith('zh') ? '🎙 Listening (Mandarin)…' : '🎙 Listening (English)…', true);
  recognizer.start();
}

function stopListening() {
  if (recognizer) { recognizer.onend = null; recognizer.abort(); recognizer = null; }
}

// ---------- flow ----------

async function handle(result) {
  if (result.status) renderStatus(result.status);
  renderView(result);
  listenLang = result.listen;
  await speakAll(result.say || []);
  if (result.ended) { stopTalking(); setStatus('Session saved. See you next time.'); return; }
  listen();
}

async function send(text) {
  if (busy) return;
  busy = true;
  stopListening();
  speechSynthesis.cancel();
  addLog('roy', text);
  setStatus('Thinking…');
  try {
    const result = await api('POST', '/api/session/message', { text });
    busy = false;
    await handle(result);
  } catch (err) {
    busy = false;
    setStatus(`Problem: ${err.message}`);
  }
}

function stopTalking() {
  active = false;
  stopListening();
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  talkBtn.textContent = '🎙 START TALKING';
  talkBtn.setAttribute('aria-pressed', 'false');
}

talkBtn.addEventListener('click', async () => {
  if (active) { stopTalking(); setStatus('Paused. Press the button to carry on.'); return; }
  active = true;
  silentRetries = 0;
  talkBtn.textContent = '⏸ PAUSE';
  talkBtn.setAttribute('aria-pressed', 'true');
  setStatus('Starting…');
  try {
    await handle(await api('POST', '/api/session/start'));
  } catch (err) {
    stopTalking();
    setStatus(`Problem: ${err.message}`);
  }
});

for (const btn of document.querySelectorAll('.quick button')) {
  btn.addEventListener('click', () => {
    if (!active) { active = true; talkBtn.textContent = '⏸ PAUSE'; talkBtn.setAttribute('aria-pressed', 'true'); }
    send(btn.dataset.say);
  });
}

$('type-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('type-input').value.trim();
  if (!text) return;
  $('type-input').value = '';
  if (!active) { active = true; talkBtn.textContent = '⏸ PAUSE'; talkBtn.setAttribute('aria-pressed', 'true'); }
  send(text);
});

if ('speechSynthesis' in window) speechSynthesis.getVoices();
api('GET', '/api/status').then((s) => { renderStatus(s); if (s.session) renderView(s.session); }).catch(() => {});

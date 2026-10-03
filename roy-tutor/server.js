import { envFile, envKeysFromFile, envProblems, envNotices, envSource } from './src/env.js'; // must stay the first import
import http from 'node:http';
import { execSync } from 'node:child_process';
import https from 'node:https';
import OpenAI from 'openai'; // HTTP client for Qwen's OpenAI-compatible API (error types)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, activeCourse, entryAt, getListenContent, saveListenContent } from './src/db.js';
import { loadConfiguredCourses } from './src/curriculum.js';
import { createTeacher } from './src/teacher.js';
import { Tutor } from './src/tutor.js';
import { serverUrls } from './src/network.js';
import { createSetupServer } from './src/devsetup.js';
import { listenLesson } from './src/listen.js';
import { createListenWriter, templateContent, isCurrent, CONTENT_VERSION } from './src/listencontent.js';
import { createVoice, SpeechStore, VoiceError, audioMime, MAX_AUDIO_BYTES, asrEndpointProblem } from './src/voice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3000);
// Development server: listen on every network adapter so a phone on the same
// Wi-Fi can connect. Set HOST=127.0.0.1 to allow this computer only.
const HOST = process.env.HOST || '0.0.0.0';
// Optional HTTPS (needed for the microphone on a phone): paths to a
// certificate and key, e.g. made with mkcert. Both must be set.
const HTTPS_CERT = process.env.TUTOR_HTTPS_CERT || '';
const HTTPS_KEY = process.env.TUTOR_HTTPS_KEY || '';
// Optional shared passcode so the app is not open to anyone who finds the URL.
const ACCESS_CODE = process.env.TUTOR_ACCESS_CODE || '';
// HTTPS development mode (npm run start:https): the local CA certificate the
// phone installs, and the plain-HTTP port that offers it for download.
const DEV_CA = process.env.TUTOR_DEV_CA || '';
const SETUP_PORT = process.env.TUTOR_SETUP_PORT || '3000';
const DEV_CA_FINGERPRINT = process.env.TUTOR_DEV_CA_FINGERPRINT || '';

const db = openDb(process.env.TUTOR_DB || path.join(here, 'tutor.db'));
// The courses (data/courses.json): any number of course documents, one active
// at a time; every course is taught by the same teacher. TUTOR_DATA_DIR points
// to another data folder (tests use this).
const dataDir = path.resolve(process.env.TUTOR_DATA_DIR || path.join(here, 'data'));
for (const r of loadConfiguredCourses(db, dataDir)) {
  if (!r.ok) { console.error(`Curriculum ${r.course} failed to load:`, r.errors); process.exit(1); }
  console.log(`Curriculum ${r.course}: ${r.count} entries`);
  r.warnings.forEach((w) => console.warn(`  note: ${w}`));
}
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const teacher = createTeacher();
// Which code is running: the version, the git commit and the folder the page
// is served from (an old copy of the project elsewhere shows up here).
const commit = (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: here, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' }).trim() || null; } catch { return null; }
})();
console.log(`Roy Medical Chinese tutor ${pkg.version}${commit ? ` (commit ${commit})` : ''}`);
console.log(`Serving the page from: ${publicDir}`);
console.log(envFile ? `Environment file: ${envFile}` : 'Environment file: none found (looked for roy-tutor/.env and the repository root .env)');
envProblems.forEach((p) => console.error(`  ${p}`));
envNotices.forEach((n) => console.warn(`  note: ${n}`));
console.log('AI provider: Qwen');
console.log(`model: ${teacher.model}`);
console.log(`endpoint: ${teacher.baseURL}`);
if (teacher.configured) {
  console.log(`DASHSCOPE_API_KEY: detected (value hidden)${envKeysFromFile.includes('DASHSCOPE_API_KEY') ? ' from the .env file' : ' from the shell environment'}`);
} else {
  console.error('Qwen is not configured: DASHSCOPE_API_KEY is missing.');
  console.error('  The tutor will not run lessons until it is set. There is no scripted fallback.');
}
const voice = createVoice();
// Teacher audio: synthesised only when the page asks for a line, one Qwen TTS
// request at a time, cached (memory + disk, next to the database) so a line said
// before is never requested again; 429 is retried a few times with backoff.
const audioCache = process.env.TUTOR_AUDIO_CACHE === 'off' ? null
  : path.resolve(process.env.TUTOR_AUDIO_CACHE || path.join(path.dirname(path.resolve(process.env.TUTOR_DB || path.join(here, 'tutor.db'))), 'audio-cache'));
// (An unset or empty value keeps the default 1 s / 3 s / 8 s; '' must not become [0].)
const retryDelays = (process.env.QWEN_TTS_RETRY_MS || '').split(',').map((v) => v.trim()).filter((v) => v !== '').map(Number).filter((v) => Number.isFinite(v) && v >= 0);
const speech = new SpeechStore(voice, {
  cacheDir: audioCache,
  ...(retryDelays.length ? { retryDelays } : {}),
  ...(process.env.QWEN_TTS_MIN_GAP_MS ? { minGapMs: Number(process.env.QWEN_TTS_MIN_GAP_MS) || 0 } : {}),
});
console.log(`speech recognition: Qwen ${voice.asrModel} (QWEN_ASR_MODEL from ${envSource('QWEN_ASR_MODEL')}), ${voice.asrProtocol === 'native' ? 'native DashScope' : 'OpenAI-compatible'} API at ${voice.asrURL}`);
if (asrEndpointProblem(voice.asrURL)) console.error(`  ${asrEndpointProblem(voice.asrURL)}`);
console.log(`teacher voice: Qwen ${voice.ttsModel} (voice ${voice.ttsVoice}) at ${voice.ttsURL}`);
console.log(`teacher voice requests: one at a time, 429 retried after ${speech.retryDelays.join(' / ')} ms; audio cache: ${audioCache ?? 'off'}`);
const tutor = new Tutor({ db, teacher, userId: process.env.TUTOR_USER_ID || 'roy', userName: process.env.TUTOR_USER_NAME || 'Roy' });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; media-src 'self' blob:",
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw Object.assign(new Error('Request too large'), { status: 413 });
  }
  return raw ? JSON.parse(raw) : {};
}

async function readAudio(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_AUDIO_BYTES) throw new VoiceError('audio_too_large', 'The recording is too long. Keep answers under about a minute.', { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(publicDir + path.sep)) return send(res, 404, 'Not found', 'text/plain');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', 'text/plain');
    send(res, 200, data, TYPES[path.extname(file)] || 'application/octet-stream');
  });
}

// One tutor request at a time, so overlapping requests cannot corrupt session state.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

const withVoice = (result) => speech.attach(result);

const routes = {
  'GET /api/status': () => ({ ...tutor.status(), version: pkg.version, commit, voice: { configured: voice.configured, asrModel: voice.asrModel, ttsModel: voice.ttsModel } }),
  'POST /api/session/start': async () => withVoice(await tutor.start()),
  'POST /api/session/message': async (body) => withVoice(await tutor.message(String(body.text ?? '').slice(0, 500), {
    source: body.source === 'voice' ? 'voice' : 'text',
    alternatives: Array.isArray(body.alternatives) ? body.alternatives.slice(0, 5).map((a) => String(a).slice(0, 500)) : [],
    confidence: Number.isFinite(body.confidence) ? body.confidence : null,
    language: typeof body.language === 'string' ? body.language.slice(0, 20) : null,
  })),
  'POST /api/session/end': async () => withVoice(await tutor.end()),
};

// Listen & Learn. It shares Roy's curriculum position with Interactive
// Practice (see Tutor.listenPlan / completeByListening). Fetching a lesson
// changes nothing; only a report that a whole lesson finished playing does.
const listenWriter = createListenWriter();
const writing = new Map(); // entry id -> pending example, so each word is written once

async function listenContent(entry, { generate, courseTitle }) {
  const saved = getListenContent(db, entry.id);
  if (isCurrent(saved)) return saved;
  // Nothing stored yet, or stored before explanations existed: the old
  // sentence is kept (with the plain explanation) until Qwen writes it anew.
  const plain = templateContent(entry, { courseTitle });
  const fallback = saved ? { ...plain, ...saved, v: CONTENT_VERSION, dialogue: [] } : plain;
  if (!generate) return fallback;
  if (!writing.has(entry.id)) {
    writing.set(entry.id, listenWriter.write(entry, { courseTitle }).then(({ content, source }) => {
      if (source === 'teacher') saveListenContent(db, entry.id, content, listenWriter.model);
      return source === 'teacher' ? content : fallback;
    }).finally(() => writing.delete(entry.id)));
  }
  return writing.get(entry.id);
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

// GET /api/listen                 what to play now: the first review lesson of
//                                 a new study day, else Roy's current word
// GET /api/listen?position=N      word N (&review=1 for its review lesson)
// ?audio=0                        text only, nothing generated or synthesised
// Each lesson says what follows it (`next`), so the page plays on by itself.
async function listenRoute(url) {
  const plan = tutor.listenPlan();
  if (!plan) throw Object.assign(new Error('No curriculum is loaded.'), { status: 404 });
  const course = activeCourse(db);
  const raw = url.searchParams.get('position');
  let position;
  let review;
  if (raw === null) {
    review = plan.review.length > 0;
    position = review ? plan.review[0] : plan.position ?? plan.total;
  } else {
    position = Number(raw);
    review = url.searchParams.get('review') === '1' && plan.review.includes(position);
  }
  if (!Number.isInteger(position) || position < 1 || position > plan.total) throw badRequest(`Word ${raw} is not in the curriculum (1-${plan.total}).`);
  const entry = entryAt(db, course.id, position);
  const textOnly = url.searchParams.get('audio') === '0';
  const content = await listenContent(entry, { generate: !textOnly, courseTitle: course.title });
  const lesson = listenLesson(entry, plan.total, content, { review });
  // What plays after this lesson: the next review word, then the current
  // word; after a word, the one after it (in curriculum order).
  let next = null;
  if (review) {
    const i = plan.review.indexOf(position);
    next = i + 1 < plan.review.length ? { position: plan.review[i + 1], review: true } : plan.position ? { position: plan.position, review: false } : null;
  } else if (position < plan.total) {
    next = { position: position + 1, review: false };
  }
  const body = { ...lesson, course: { id: course.id, title: course.title }, review, next, reviewCount: plan.review.length, reviewIndex: review ? plan.review.indexOf(position) : null, ...tutor.listenProgress() };
  return textOnly ? body : speech.attachTo(body, 'steps');
}

// POST /api/listen/complete {position, review}  every step of that lesson
// played. Completes Roy's current word (shared with Interactive Practice);
// anything else is only logged. The last review lesson ends the day's review.
function listenCompleteRoute(body) {
  const position = Number(body?.position);
  if (!Number.isInteger(position)) throw badRequest('position is required');
  const plan = tutor.listenPlan();
  const review = body.review === true && plan.review.includes(position);
  const result = tutor.completeByListening(position, { review });
  if (review && plan.review.at(-1) === position) tutor.listenReviewDone();
  return result;
}

// The entry the lesson is on now, read from the curriculum (the card hides the
// Mandarin during review; recognition context still needs it). Read only.
function currentEntry() {
  try {
    const position = tutor.status().session?.card?.position;
    const course = activeCourse(db);
    return position && course ? entryAt(db, course.id, position) : null;
  } catch {
    return null;
  }
}

// Audio routes: the raw recording in, a transcript out; and teacher audio by
// line id. They do not touch lesson state, so they are not queued.
async function audioRoute(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/voice/transcribe') {
    const mime = audioMime(req.headers['content-type']);
    if (!mime) throw new VoiceError('asr_bad_audio', 'Unsupported audio format.', { status: 415 });
    const audio = await readAudio(req);
    const lang = url.searchParams.get('lang') === 'en-US' ? 'en-US' : 'zh-CN';
    return send(res, 200, await voice.transcribe(audio, mime, lang, { entry: currentEntry() }));
  }
  const m = req.method === 'GET' && url.pathname.match(/^\/api\/voice\/speech\/([a-z0-9]{1,40})$/);
  if (m) {
    // If the page gives up on this line (Next, Pause, a new lesson), a request
    // still waiting in the TTS queue is dropped instead of being sent to Qwen.
    const gone = new AbortController();
    res.on('close', () => { if (!res.writableEnded) gone.abort(); });
    const job = speech.get(m[1], { signal: gone.signal });
    if (!job) return send(res, 404, { error: 'That audio has expired.', code: 'tts_expired' });
    const { audio, mime } = await job;
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': audio.length, 'Cache-Control': 'no-store', ...SECURITY_HEADERS });
    return res.end(audio);
  }
  return false;
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = routes[`${req.method} ${url.pathname}`];
  const isVoice = url.pathname.startsWith('/api/voice/');
  const isListen = (req.method === 'GET' && url.pathname === '/api/listen') || (req.method === 'POST' && url.pathname === '/api/listen/complete');
  if (isListen) {
    if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'Access code required' });
    try {
      if (req.method === 'GET') return send(res, 200, await listenRoute(url));
      // Queued with lesson turns: it may move today's Interactive session on.
      const body = await readJson(req);
      return send(res, 200, await serial(() => listenCompleteRoute(body)));
    } catch (err) {
      if (!err.status) console.error(err);
      return send(res, err.status ?? 500, { error: err.status ? err.message : 'Something went wrong' });
    }
  }
  // Which version is running (no access code needed: version and commit only).
  if (req.method === 'GET' && url.pathname === '/api/version') return send(res, 200, { version: pkg.version, commit });
  if (!route && !isVoice) return req.method === 'GET' ? serveStatic(req, res) : send(res, 404, { error: 'Not found' });
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'Access code required' });
  try {
    if (isVoice) {
      if ((await audioRoute(req, res, url)) === false) send(res, 404, { error: 'Not found' });
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await serial(() => route(body)));
  } catch (err) {
    if (err instanceof VoiceError) {
      if (err.code === 'tts_cancelled') return; // the page left; nobody to answer
      // Qwen's own error text stays in the server log.
      console.error(`[voice] ${err.code}: ${err.message}${err.detail ? ` ${err.detail}` : ''}`);
      if (err.status === 413) req.resume();
      return send(res, err.status, { error: err.message, code: err.code });
    }
    console.error(err);
    if (err.code === 'ai_not_configured') return send(res, 503, { error: err.message, code: err.code });
    if (err.code === 'ai_bad_reply') {
      return send(res, 502, { error: 'The AI teacher (Qwen) sent an unusable reply. Nothing was counted; try again.', code: 'ai_request_failed' });
    }
    if (err instanceof OpenAI.APIConnectionTimeoutError) {
      return send(res, 504, { error: 'The AI teacher (Qwen) took too long to answer. Nothing was counted; try again.', code: 'ai_request_failed' });
    }
    if (err instanceof OpenAI.APIError) {
      // Do not pass the provider's error text to the browser; the server log has it.
      return send(res, 502, { error: `The AI teacher request failed (status ${err.status ?? 'none'}). Check DASHSCOPE_API_KEY, QWEN_MODEL and QWEN_BASE_URL on the server.`, code: 'ai_request_failed' });
    }
    send(res, err.status === 413 ? 413 : 500, { error: err.status === 413 ? err.message : 'Something went wrong', code: null });
  }
}

const secure = Boolean(HTTPS_CERT && HTTPS_KEY);
const server = secure
  ? https.createServer({ cert: fs.readFileSync(HTTPS_CERT), key: fs.readFileSync(HTTPS_KEY) }, handler)
  : http.createServer(handler);

const setupPort = secure && DEV_CA && SETUP_PORT !== 'off' && Number(SETUP_PORT) !== PORT ? Number(SETUP_PORT) : null;

// Another tutor (often an older version in another window) still has the port:
// say so plainly instead of crashing, so the page is never served by an old server.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n!! Port ${PORT} is already in use: another Roy tutor server (probably an older version) is still running.`);
    console.error('   Close that window (or press Ctrl+C in it), then start the tutor again.');
    console.error('   Until then the browser keeps talking to the OLD server and its old page.\n');
  } else {
    console.error(`!! The tutor could not start on port ${PORT}: ${err.code || err.message}`);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const urls = serverUrls({ host: HOST, port: server.address().port, secure });
  console.log(`Roy Medical Chinese tutor on ${urls.local}`);
  if (urls.lan.length) {
    console.log(`On your phone (same Wi-Fi or the laptop's hotspot), open:`);
    for (const a of urls.lan) console.log(`  ${a.url}   (${a.name}${a.hotspot ? ' - Windows Mobile Hotspot: use this one for a phone on the hotspot' : ''})`);
    if (!secure) console.log('  Note: phones only allow the microphone on https:// or localhost. See README "Testing on a phone".');
    if (!ACCESS_CODE) console.log('  Tip: set TUTOR_ACCESS_CODE so other people on this network cannot use your Qwen quota.');
  } else if (HOST !== '0.0.0.0' && HOST !== '::') {
    console.log(`Listening on ${HOST} only (not reachable from other devices).`);
  }
});

// First-time phone setup over plain HTTP: download and trust the local CA.
if (setupPort !== null) {
  const setup = createSetupServer({ caFile: DEV_CA, httpsPort: PORT, fingerprint: DEV_CA_FINGERPRINT });
  setup.on('error', (err) => console.error(`  Phone setup page not started on port ${setupPort}: ${err.code || err.message}. Is "npm start" still running? Stop it, or set TUTOR_SETUP_PORT.`));
  setup.listen(setupPort, HOST, () => {
    const urls = serverUrls({ host: HOST, port: setup.address().port, secure: false });
    console.log('');
    console.log('First time on the iPhone: trust the development certificate. In Safari open:');
    for (const a of urls.lan) console.log(`  ${a.url}/   (${a.name}${a.hotspot ? ', hotspot' : ''})`);
    if (!urls.lan.length) console.log(`  ${urls.local}/`);
    console.log('  then follow the steps on that page (download, install profile, turn on full trust).');
    if (DEV_CA_FINGERPRINT) console.log(`  Certificate fingerprint (SHA-256): ${DEV_CA_FINGERPRINT}`);
  });
}

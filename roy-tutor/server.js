import { envFile, envKeysFromFile, envProblems } from './src/env.js'; // must stay the first import
import http from 'node:http';
import OpenAI from 'openai'; // HTTP client for Qwen's OpenAI-compatible API (error types)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { loadConfiguredCourses } from './src/curriculum.js';
import { createTeacher } from './src/teacher.js';
import { Tutor } from './src/tutor.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const PORT = Number(process.env.PORT || 3000);
// Optional shared passcode so the app is not open to anyone who finds the URL.
const ACCESS_CODE = process.env.TUTOR_ACCESS_CODE || '';

const db = openDb(process.env.TUTOR_DB || path.join(here, 'tutor.db'));
for (const r of loadConfiguredCourses(db, path.join(here, 'data'))) {
  if (!r.ok) { console.error(`Curriculum ${r.course} failed to load:`, r.errors); process.exit(1); }
  console.log(`Curriculum ${r.course}: ${r.count} entries`);
  r.warnings.forEach((w) => console.warn(`  note: ${w}`));
}
const pkg = JSON.parse(fs.readFileSync(path.join(here, 'package.json'), 'utf8'));
const teacher = createTeacher();
console.log(`Roy Medical Chinese tutor ${pkg.version}`);
console.log(envFile ? `Environment file: ${envFile}` : 'Environment file: none found (looked for roy-tutor/.env and the repository root .env)');
envProblems.forEach((p) => console.error(`  ${p}`));
console.log('AI provider: Qwen');
console.log(`model: ${teacher.model}`);
console.log(`endpoint: ${teacher.baseURL}`);
if (teacher.configured) {
  console.log(`DASHSCOPE_API_KEY: detected (value hidden)${envKeysFromFile.includes('DASHSCOPE_API_KEY') ? ' from the .env file' : ' from the shell environment'}`);
} else {
  console.error('Qwen is not configured: DASHSCOPE_API_KEY is missing.');
  console.error('  The tutor will not run lessons until it is set. There is no scripted fallback.');
}
const tutor = new Tutor({ db, teacher, userId: process.env.TUTOR_USER_ID || 'roy', userName: process.env.TUTOR_USER_NAME || 'Roy' });

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:",
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

const routes = {
  'GET /api/status': () => tutor.status(),
  'POST /api/session/start': () => tutor.start(),
  'POST /api/session/message': (body) => tutor.message(String(body.text ?? '').slice(0, 500), {
    source: body.source === 'voice' ? 'voice' : 'text',
    alternatives: Array.isArray(body.alternatives) ? body.alternatives.slice(0, 5).map((a) => String(a).slice(0, 500)) : [],
    confidence: Number.isFinite(body.confidence) ? body.confidence : null,
    language: typeof body.language === 'string' ? body.language.slice(0, 20) : null,
  }),
  'POST /api/session/end': () => tutor.end(),
};

http.createServer(async (req, res) => {
  const route = routes[`${req.method} ${req.url.split('?')[0]}`];
  if (!route) return req.method === 'GET' ? serveStatic(req, res) : send(res, 404, { error: 'Not found' });
  if (ACCESS_CODE && req.headers['x-access-code'] !== ACCESS_CODE) return send(res, 401, { error: 'Access code required' });
  try {
    const body = req.method === 'POST' ? await readJson(req) : {};
    send(res, 200, await serial(() => route(body)));
  } catch (err) {
    console.error(err);
    if (err.code === 'ai_not_configured') return send(res, 503, { error: err.message, code: err.code });
    if (err instanceof OpenAI.APIError) {
      // Do not pass the provider's error text to the browser; the server log has it.
      return send(res, 502, { error: `The AI teacher request failed (status ${err.status ?? 'none'}). Check DASHSCOPE_API_KEY, QWEN_MODEL and QWEN_BASE_URL on the server.`, code: 'ai_request_failed' });
    }
    send(res, err.status === 413 ? 413 : 500, { error: err.status === 413 ? err.message : 'Something went wrong', code: null });
  }
}).listen(PORT, () => console.log(`Roy Medical Chinese tutor on http://localhost:${PORT}`));

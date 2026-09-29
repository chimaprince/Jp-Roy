// Regression: QWEN_ASR_MODEL from .env must decide the ASR model and protocol.
// A local check once printed "ASR model: qwen3-asr-flash ... request=openai"
// although .env said qwen-audio-3.1-asr-flash: a stale shell/system variable
// (or a duplicate line) silently won over .env.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadEnv } from '../src/env.js';
import { createVoice, voiceSettings, asrProtocol, ASR_DEFAULT_MODEL } from '../src/voice.js';
import { encodeWav } from '../public/voice-core.js';
import { cleanEnv } from './helpers.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAV = Buffer.from(encodeWav(new Float32Array(1600).fill(0.1), 16000));
const WS = 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
const NATIVE = 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const quiet = () => {};


function tempEnv(text, name = '.env') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-env-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { dir, file };
}

// Records every request; answers with the given status.
function recorder(status = 200) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    const raw = JSON.stringify(status === 200 ? { output: { text: '硬膜外' } } : { code: 'Err', message: 'no' });
    return { ok: status === 200, status, text: async () => raw };
  };
  return { fn, calls };
}

// ---------- .env is the source of truth ----------

test('.env wins over a stale shell/system QWEN_ASR_MODEL, and the override is reported', () => {
  const { file } = tempEnv('DASHSCOPE_API_KEY=sk-from-file\nQWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\n');
  const env = { TUTOR_ENV_FILE: file, QWEN_ASR_MODEL: 'qwen3-asr-flash', DASHSCOPE_API_KEY: 'sk-from-shell' };
  const r = loadEnv({ env });
  assert.equal(env.QWEN_ASR_MODEL, 'qwen-audio-3.1-asr-flash');
  assert.equal(r.sources.QWEN_ASR_MODEL, '.env');
  const note = r.notices.find((n) => n.startsWith('QWEN_ASR_MODEL'));
  assert.match(note, /"qwen-audio-3\.1-asr-flash".*not "qwen3-asr-flash"/);
  const keyNote = r.notices.find((n) => n.startsWith('DASHSCOPE_API_KEY'));
  assert.ok(keyNote, 'a key override is reported too');
  assert.doesNotMatch(r.notices.join('\n'), /sk-from/, 'secret values are never shown');
  const voice = createVoice({ env, fetchImpl: recorder().fn, log: quiet });
  assert.equal(voice.asrModel, 'qwen-audio-3.1-asr-flash');
  assert.equal(voice.asrProtocol, 'native');
});

test('a duplicate QWEN_ASR_MODEL line in .env is reported, not silently used', () => {
  const { file } = tempEnv('QWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\nQWEN_ASR_MODEL=qwen3-asr-flash\n');
  const env = { TUTOR_ENV_FILE: file };
  const r = loadEnv({ env });
  assert.match(r.problems.join('\n'), /QWEN_ASR_MODEL appears more than once.*LAST line is used \("qwen3-asr-flash"\)/);
});

test('a second .env that is not loaded is reported', () => {
  const a = tempEnv('QWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\n');
  const b = tempEnv('QWEN_ASR_MODEL=qwen3-asr-flash\n');
  const r = loadEnv({ env: {}, candidates: [a.file, b.file] });
  assert.equal(r.file, a.file);
  assert.match(r.notices.join('\n'), /also exists but is NOT loaded/);
});

test('TUTOR_ENV_FILE=none loads no file (tests never read a real .env)', () => {
  const env = { TUTOR_ENV_FILE: 'none', QWEN_ASR_MODEL: 'x' };
  const r = loadEnv({ env });
  assert.equal(r.file, null);
  assert.equal(env.QWEN_ASR_MODEL, 'x');
});

// ---------- the model decides the path ----------

test('default ASR model is qwen-audio-3.1-asr-flash on the native path', () => {
  assert.equal(ASR_DEFAULT_MODEL, 'qwen-audio-3.1-asr-flash');
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: 'k' }, log: quiet });
  assert.equal(voice.asrModel, 'qwen-audio-3.1-asr-flash');
  assert.equal(voice.asrProtocol, 'native');
});

test('QWEN_ASR_MODEL=qwen-audio-3.1-asr-flash selects the native DashScope request, never the OpenAI-compatible one', async () => {
  for (const value of ['qwen-audio-3.1-asr-flash', ' qwen-audio-3.1-asr-flash ', 'qwen-audio-3.1-asr-flash\r']) {
    const { fn, calls } = recorder();
    const voice = createVoice({ env: { DASHSCOPE_API_KEY: 'k', QWEN_ASR_MODEL: value, QWEN_ASR_BASE_URL: WS }, fetchImpl: fn, log: quiet });
    assert.equal(voice.asrModel, 'qwen-audio-3.1-asr-flash', `value ${JSON.stringify(value)}`);
    assert.equal(voice.asrProtocol, 'native');
    const out = await voice.transcribe(WAV, 'audio/wav', 'zh-CN');
    assert.equal(out.model, 'qwen-audio-3.1-asr-flash');
    assert.notEqual(out.request, 'openai');
    assert.equal(calls[0].url, NATIVE);
    assert.equal(calls[0].body.model, 'qwen-audio-3.1-asr-flash');
    assert.ok(calls[0].body.input?.messages, 'native body: input.messages');
    assert.equal(calls[0].body.messages, undefined, 'no OpenAI-style top-level messages');
    assert.equal(calls[0].body.asr_options, undefined, 'no qwen3-asr asr_options');
  }
});

test('qwen3-asr-flash is never a fallback when qwen-audio-3.1-asr-flash is configured', async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const { fn, calls } = recorder(status);
    const voice = createVoice({ env: { DASHSCOPE_API_KEY: 'k', QWEN_ASR_MODEL: 'qwen-audio-3.1-asr-flash', QWEN_ASR_BASE_URL: WS }, fetchImpl: fn, log: quiet });
    await assert.rejects(voice.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed' && e.httpStatus === status);
    assert.ok(calls.length >= 1);
    for (const c of calls) {
      assert.equal(c.url, NATIVE, `status ${status}: only the native endpoint is called`);
      assert.doesNotMatch(c.url, /chat\/completions/);
      assert.equal(c.body.model, 'qwen-audio-3.1-asr-flash', `status ${status}: the model is never swapped`);
    }
  }
  const down = createVoice({ env: { DASHSCOPE_API_KEY: 'k', QWEN_ASR_BASE_URL: WS }, fetchImpl: async () => { throw new Error('ECONNRESET'); }, log: quiet });
  await assert.rejects(down.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed');
  assert.equal(asrProtocol('qwen-audio-3.1-asr-flash'), 'native');
  assert.equal(voiceSettings({ QWEN_ASR_MODEL: '' }).asrModel, 'qwen-audio-3.1-asr-flash', 'an empty value means the default, not qwen3');
});

// ---------- the real entry points ----------

function run(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { cwd: appDir, env });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), 15000);
    const done = () => { clearTimeout(timer); resolve(out); };
    child.on('exit', done);
    child.stdout.on('data', () => { if (out.includes('Roy Medical Chinese tutor on')) { child.kill(); } });
  });
}

test('check-voice: first lines show qwen-audio-3.1-asr-flash and native DashScope, even with a stale shell variable', async () => {
  const { file } = tempEnv(`QWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\nQWEN_ASR_BASE_URL=${WS}\n`);
  // No key: check-voice prints its settings and stops before any request.
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: file, QWEN_ASR_MODEL: 'qwen3-asr-flash', DASHSCOPE_API_KEY: '' };
  const out = await run(['scripts/check-voice.mjs'], env);
  const lines = out.split('\n');
  assert.equal(lines[0], 'ASR model: qwen-audio-3.1-asr-flash');
  assert.equal(lines[1], 'ASR protocol: native DashScope');
  assert.equal(lines[2], `ASR endpoint: ${NATIVE}`);
  assert.match(out, /QWEN_ASR_MODEL from: \.env/);
  assert.match(out, /QWEN_ASR_MODEL: using "qwen-audio-3\.1-asr-flash" from \.env, not "qwen3-asr-flash"/);
  assert.doesNotMatch(out, /qwen3-asr-flash.*request=openai|ASR model: qwen3/);
});

test('server startup: .env model is used and logged with its protocol', async () => {
  const { file } = tempEnv(`DASHSCOPE_API_KEY=test-key-not-real\nQWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\nQWEN_ASR_BASE_URL=${WS}\n`);
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-db-'));
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: file, QWEN_ASR_MODEL: 'qwen3-asr-flash', PORT: '0', HOST: '127.0.0.1', TUTOR_DB: path.join(dbDir, 'tutor.db') };
  const out = await run(['server.js'], env);
  assert.match(out, /speech recognition: Qwen qwen-audio-3\.1-asr-flash \(QWEN_ASR_MODEL from \.env\), native DashScope API at https:\/\/ws-test123\.ap-southeast-1\.maas\.aliyuncs\.com\/api\/v1\/services\/aigc\/multimodal-generation\/generation/);
  assert.match(out, /note: QWEN_ASR_MODEL: using "qwen-audio-3\.1-asr-flash"/);
  assert.match(out, /teacher voice: Qwen qwen3-tts-instruct-flash/, 'TTS unchanged');
  assert.doesNotMatch(out, /test-key-not-real/);
});

test('check-voice reads the key from the .env file (like the server), reports both HTTP 200s, never prints the key', async () => {
  const wav = Buffer.from(encodeWav(Float32Array.from({ length: 24000 }, (_, i) => 0.2 * Math.sin(i / 10)), 24000));
  const auth = new Set();
  const http = await import('node:http');
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.headers.authorization) auth.add(req.headers.authorization);
    const json = (b) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/api/v1/services/aigc/multimodal-generation/generation') {
      const body = JSON.parse(raw);
      return body.model.includes('tts') ? json({ output: { audio: { data: wav.toString('base64') } } }) : json({ output: { text: '硬膜外。医生说：我们需要打硬膜外。' } });
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const key = 'sk-only-in-the-env-file-424242';
  const { file, dir } = tempEnv(`DASHSCOPE_API_KEY=${key}\nQWEN_ASR_MODEL=qwen-audio-3.1-asr-flash\nQWEN_ASR_BASE_URL=${base}/compatible-mode/v1\nQWEN_TTS_URL=${base}/api/v1/services/aigc/multimodal-generation/generation\n`);
  try {
    // The shell has no key at all: it can only come from the file.
    const out = await run(['scripts/check-voice.mjs'], { ...cleanEnv(), TUTOR_ENV_FILE: file });
    assert.ok(out.includes(`DASHSCOPE_API_KEY: detected (value hidden) from ${file}`), out);
    assert.match(out, /TTS HTTP status: 200/);
    assert.match(out, /OK {2}playable in the browser: WAV pcm/);
    assert.match(out, /ASR HTTP status: 200/);
    assert.match(out, /ASR transcript: 硬膜外。医生说：我们需要打硬膜外。/);
    assert.match(out, /All voice checks passed\./);
    assert.ok(!out.includes(key), 'the key is never printed');
    assert.deepEqual([...auth], [`Bearer ${key}`], 'sent only as the Authorization header');
    fs.rmSync(path.join(appDir, 'voice-check.wav'), { force: true });

    const missing = await run(['scripts/check-voice.mjs'], { ...cleanEnv(), TUTOR_ENV_FILE: path.join(dir, 'nope.env') });
    assert.match(missing, /DASHSCOPE_API_KEY is missing\. Env file loaded: none \(looked for: .*nope\.env\)/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

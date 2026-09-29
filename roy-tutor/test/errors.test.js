// Failure handling through the real server: a Qwen teacher that times out or
// sends unusable replies gives a clear error, and nothing is counted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { qwenSettings } from '../src/teacher.js';
import { friendlyError } from '../public/voice-core.js';
import { freePort, cleanEnv } from './helpers.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('Qwen requests have a bounded timeout (default 30 s, QWEN_TIMEOUT_MS to change)', () => {
  assert.equal(qwenSettings({}).timeoutMs, 30000);
  assert.equal(qwenSettings({ QWEN_TIMEOUT_MS: '5000' }).timeoutMs, 5000);
  assert.equal(qwenSettings({ QWEN_TIMEOUT_MS: 'nonsense' }).timeoutMs, 30000);
});

// A Qwen teacher stand-in that misbehaves in the chosen way.
async function badTeacher(mode) {
  let calls = 0;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls += 1;
    if (mode === 'hang') return; // never answers
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // 'no-speech': valid JSON but nothing to say (cannot be repaired).
    const content = mode === 'garbage' ? 'this is not JSON at all' : JSON.stringify({ intent: 'answer', correct: true });
    res.end(JSON.stringify({ id: 'x', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }] }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, calls: () => calls, close: () => { server.closeAllConnections?.(); return new Promise((r) => server.close(r)); } };
}

async function startServer(teacherPort) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-errors-'));
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: 'test-key-errors', QWEN_BASE_URL: `http://127.0.0.1:${teacherPort}/v1`, QWEN_TIMEOUT_MS: '400' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('tutor on')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const url = `http://localhost:${port}`;
  const stop = () => { const exited = new Promise((r) => child.once('exit', r)); child.kill(); return exited; };
  return { url, stop, output: () => out };
}

for (const [mode, status, pattern] of [
  ['hang', 504, /took too long/],
  ['garbage', 502, /unusable reply/],
  ['no-speech', 502, /unusable reply/],
]) {
  test(`Qwen teacher ${mode}: ${status} with a clear message; nothing counted; the page explains it`, async () => {
    const t = await badTeacher(mode);
    const s = await startServer(t.port);
    try {
      const r = await fetch(`${s.url}/api/session/start`, { method: 'POST' });
      assert.equal(r.status, status);
      const body = await r.json();
      assert.equal(body.code, 'ai_request_failed');
      assert.match(body.error, pattern);
      assert.match(body.error, /Nothing was counted/);
      assert.doesNotMatch(JSON.stringify(body), /test-key-errors/);
      assert.ok(t.calls() >= 2, 'one retry');
      const st = await (await fetch(`${s.url}/api/status`)).json();
      assert.equal(st.position, 1);
      assert.equal(st.completed, 0);
      assert.match(friendlyError(body), /didn't answer/);
    } finally {
      await s.stop();
      await t.close();
    }
  });
}

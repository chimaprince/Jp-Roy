import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanAddresses, serverUrls } from '../src/network.js';
import { freePort, cleanEnv } from './helpers.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');


const FAKE_INTERFACES = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }, { address: '::1', family: 'IPv6', internal: true }],
  'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6', internal: false }, { address: '192.168.1.23', family: 'IPv4', internal: false }],
  'vEthernet (WSL)': [{ address: '169.254.10.2', family: 'IPv4', internal: false }],
  Ethernet: [{ address: '10.0.0.5', family: 4, internal: false }],
};

test('LAN addresses: IPv4 only, no loopback, no link-local', () => {
  assert.deepEqual(lanAddresses(FAKE_INTERFACES), [
    { name: 'Wi-Fi', address: '192.168.1.23' },
    { name: 'Ethernet', address: '10.0.0.5' },
  ]);
});

test('server URLs: localhost always; LAN URLs only when listening on all adapters', () => {
  const all = serverUrls({ host: '0.0.0.0', port: 3000, interfaces: FAKE_INTERFACES });
  assert.equal(all.local, 'http://localhost:3000');
  assert.deepEqual(all.lan.map((a) => a.url), ['http://192.168.1.23:3000', 'http://10.0.0.5:3000']);
  assert.deepEqual(serverUrls({ host: '127.0.0.1', port: 3000, interfaces: FAKE_INTERFACES }).lan, []);
  assert.equal(serverUrls({ host: '0.0.0.0', port: 3443, secure: true, interfaces: FAKE_INTERFACES }).lan[0].url, 'https://192.168.1.23:3443');
});

async function startServer(extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-net-'));
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: 'not-a-real-key-for-tests', ...extraEnv };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    const onData = (d) => { output += d; if (output.includes('Roy Medical Chinese tutor on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Log lines can arrive in separate chunks: wait for the one a test checks.
  const waitFor = async (re, ms = 3000) => {
    const until = Date.now() + ms;
    while (!re.test(output) && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    return output;
  };
  return { port, child, output: () => output, waitFor, stop: () => { child.kill(); return exited; } };
}

test('the server listens on all adapters, prints LAN URLs, and still works on localhost', async () => {
  const s = await startServer();
  try {
    const page = await fetch(`http://localhost:${s.port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ROY MEDICAL CHINESE/);
    const lan = lanAddresses();
    if (lan.length) {
      assert.match(await s.waitFor(/On your phone/), /On your phone \(same Wi-Fi or the laptop's hotspot\), open:/);
      const viaLan = await fetch(`http://${lan[0].address}:${s.port}/api/status`);
      assert.equal(viaLan.status, 200, 'reachable through a LAN address, not only localhost');
    }
    assert.doesNotMatch(s.output(), /not-a-real-key-for-tests/, 'the key is never printed');
  } finally { await s.stop(); }
});

test('only public/ is served: .env, package.json and server code cannot be fetched', async () => {
  const s = await startServer();
  try {
    for (const p of ['/.env', '/../.env', '/%2e%2e/.env', '/..%2f.env', '/../package.json', '/%2e%2e/server.js', '/../src/teacher.js', '/../data/jh-medics-vol1.json']) {
      const r = await fetch(`http://localhost:${s.port}${p}`);
      assert.equal(r.status, 404, `${p} must not be served`);
    }
    const status = await (await fetch(`http://localhost:${s.port}/api/status`)).text();
    assert.doesNotMatch(status, /not-a-real-key-for-tests|DASHSCOPE_API_KEY|apiKey/);
  } finally { await s.stop(); }
});

test('no CORS headers: the page and the API are same-origin, so none are needed', async () => {
  const s = await startServer();
  try {
    const r = await fetch(`http://localhost:${s.port}/api/status`, { headers: { Origin: 'http://evil.example' } });
    assert.equal(r.headers.get('access-control-allow-origin'), null);
  } finally { await s.stop(); }
});

test('HOST=127.0.0.1 keeps the server private to this computer', async () => {
  const s = await startServer({ HOST: '127.0.0.1' });
  try {
    assert.match(await s.waitFor(/Listening on 127\.0\.0\.1 only/), /Listening on 127\.0\.0\.1 only/);
    assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/status`)).status, 200);
  } finally { await s.stop(); }
});

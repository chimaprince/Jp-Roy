// HTTPS development mode (npm run start:https): the certificates, and the real
// server over HTTPS serving the same app and API, plus the phone setup page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ensureDevCerts, certHosts, SERVER_CERT_DAYS, WINDOWS_HOTSPOT_IP } from '../src/devcert.js';
import { lanAddresses, serverUrls } from '../src/network.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'test-key-not-real-https-123456';
// The developer's own Qwen/tutor settings never leak into test servers.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN_|DASHSCOPE_|TUTOR_)/.test(k)));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roy-https-'));

// ---------- certificates ----------

test('dev certificates: a CA, and a server certificate the iPhone accepts', () => {
  const dir = tmp();
  const hosts = certHosts({ lan: ['192.168.89.234'] });
  const c = ensureDevCerts({ dir, hosts });
  assert.deepEqual(c.made, { ca: true, server: true });
  const ca = new crypto.X509Certificate(fs.readFileSync(c.caCert));
  const leaf = new crypto.X509Certificate(fs.readFileSync(c.cert));
  assert.equal(ca.ca, true, 'the CA is a CA');
  assert.equal(leaf.ca, false);
  assert.ok(leaf.verify(ca.publicKey), 'server certificate signed by the CA');
  assert.equal(leaf.issuer, ca.subject);
  for (const ip of ['127.0.0.1', '192.168.89.234', WINDOWS_HOTSPOT_IP]) assert.equal(leaf.checkIP(ip), ip, `covers ${ip}`);
  assert.equal(leaf.checkHost('localhost'), 'localhost');
  assert.equal(leaf.checkIP('10.9.9.9'), undefined, 'only this laptop');
  assert.deepEqual(leaf.keyUsage, ['1.3.6.1.5.5.7.3.1'], 'serverAuth');
  const days = (Date.parse(leaf.validTo) - Date.parse(leaf.validFrom)) / 86400000;
  assert.ok(days <= 825 && days >= SERVER_CERT_DAYS, `iPhone limit: ${days} days`);
  assert.equal(leaf.publicKey.asymmetricKeyDetails.modulusLength, 2048);
  assert.match(fs.readFileSync(c.caKey, 'utf8'), /PRIVATE KEY/);
  assert.doesNotMatch(fs.readFileSync(c.caCert, 'utf8'), /PRIVATE KEY/, 'the CA file the phone gets has no key');
});

test('the CA is kept (the phone trusts it once); the server certificate follows new addresses', () => {
  const dir = tmp();
  const first = ensureDevCerts({ dir, hosts: certHosts({ lan: ['192.168.89.234'] }) });
  const again = ensureDevCerts({ dir, hosts: certHosts({ lan: ['192.168.89.234'] }) });
  assert.deepEqual(again.made, { ca: false, server: false });
  const moved = ensureDevCerts({ dir, hosts: certHosts({ lan: ['192.168.137.5'] }) });
  assert.deepEqual(moved.made, { ca: false, server: true });
  assert.equal(moved.caFingerprint, first.caFingerprint);
  assert.equal(new crypto.X509Certificate(fs.readFileSync(moved.cert)).checkIP('192.168.137.5'), '192.168.137.5');
  const later = ensureDevCerts({ dir, hosts: certHosts({ lan: ['192.168.137.5'] }), now: Date.now() + 380 * 86400000 });
  assert.equal(later.made.server, true, 're-issued before it expires');
});

test('the Windows Mobile Hotspot address is flagged in the printed URLs', () => {
  const urls = serverUrls({ host: '0.0.0.0', port: 3443, secure: true, interfaces: {
    'Wi-Fi': [{ address: '192.168.89.234', family: 'IPv4', internal: false }],
    'Local Area Connection* 10': [{ address: '192.168.137.1', family: 'IPv4', internal: false }],
  } });
  assert.deepEqual(urls.lan.map((u) => [u.url, Boolean(u.hotspot)]), [['https://192.168.89.234:3443', false], ['https://192.168.137.1:3443', true]]);
});

// ---------- the real server ----------

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function startHttps(extraEnv = {}) {
  const [port, setupPort] = [await freePort(), await freePort()];
  const dir = tmp();
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', TUTOR_CERT_DIR: dir, TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: KEY, PORT: String(port), TUTOR_SETUP_PORT: String(setupPort), ...extraEnv };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'scripts/start-https.mjs'], { cwd: appDir, env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`did not start:\n${output}`)), 20000);
    const onData = (d) => { output += d; if (/Roy Medical Chinese tutor on/.test(output) && /Certificate fingerprint/.test(output)) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`exited ${code}:\n${output}`)));
  });
  const exited = new Promise((r) => child.once('exit', r));
  return { port, setupPort, dir, ca: fs.readFileSync(path.join(dir, 'dev-ca.crt')), output: () => output, stop: () => { child.kill(); return exited; } };
}

// A request that trusts only our development CA (as the phone will).
function get(url, { ca, method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, ca, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('npm run start:https: same tutor app and API over HTTPS on all adapters, key never served', async () => {
  const s = await startHttps();
  try {
    const out = s.output();
    assert.match(out, new RegExp(`Roy Medical Chinese tutor on https://localhost:${s.port}`));
    for (const a of lanAddresses()) {
      assert.ok(out.includes(`https://${a.address}:${s.port}`), `prints the HTTPS LAN URL for ${a.address}`);
      assert.ok(out.includes(`http://${a.address}:${s.setupPort}/`), `prints the setup URL for ${a.address}`);
    }
    assert.doesNotMatch(out, new RegExp(KEY), 'the key is not printed');

    // Certificate chain verifies against the CA alone, for localhost and 127.0.0.1.
    const page = await get(`https://localhost:${s.port}/`, { ca: s.ca });
    assert.equal(page.status, 200);
    assert.match(page.body, /ROY MEDICAL CHINESE/);
    assert.equal((await get(`https://127.0.0.1:${s.port}/app.js`, { ca: s.ca })).status, 200);
    await assert.rejects(get(`https://localhost:${s.port}/`, {}), /self-signed|unable to verify|certificate/i, 'untrusted without the CA');

    const status = await get(`https://localhost:${s.port}/api/status`, { ca: s.ca });
    assert.equal(status.status, 200);
    const st = JSON.parse(status.body);
    assert.equal(st.total, 385, 'same curriculum');
    assert.equal(st.voice.asrModel, 'qwen-audio-3.1-asr-flash');
    assert.equal(st.voice.ttsModel, 'qwen3-tts-instruct-flash');
    assert.match(status.headers['content-security-policy'], /media-src 'self' blob:/);
    const voice = await get(`https://localhost:${s.port}/api/voice/transcribe?lang=zh-CN`, { ca: s.ca, method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x' });
    assert.equal(voice.status, 415, 'the voice API is there too');

    for (const p of ['/dev-ca-key.pem', '/dev-server-key.pem', '/../certs/dev-ca-key.pem', '/%2e%2e/certs/dev-server-key.pem', '/../.env']) {
      const r = await get(`https://localhost:${s.port}${p}`, { ca: s.ca });
      assert.equal(r.status, 404, `${p} is not served`);
    }
    for (const r of [page, status]) assert.ok(!r.body.includes(KEY) && !/DASHSCOPE_API_KEY=|PRIVATE KEY/.test(r.body));
  } finally {
    await s.stop();
  }
});

test('phone setup page (plain HTTP): the CA certificate only; everything else goes to HTTPS', async () => {
  const s = await startHttps();
  try {
    const base = `http://127.0.0.1:${s.setupPort}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /Download certificate/);
    assert.match(html, new RegExp(`https://127\\.0\\.0\\.1:${s.port}/`));
    assert.match(html, /Certificate Trust Settings/);

    const crt = await fetch(`${base}/dev-ca.crt`);
    assert.equal(crt.status, 200);
    assert.equal(crt.headers.get('content-type'), 'application/x-x509-ca-cert', 'iPhone Safari offers to install it');
    const body = await crt.text();
    assert.equal(body, s.ca.toString());
    assert.doesNotMatch(body, /PRIVATE KEY/);

    for (const p of ['/api/status', '/app.js', '/dev-ca-key.pem', '/dev-server-key.pem']) {
      const r = await fetch(`${base}${p}`, { redirect: 'manual' });
      assert.equal(r.status, 302, `${p} is not served over plain HTTP`);
      assert.equal(r.headers.get('location'), `https://127.0.0.1:${s.port}${p}`);
    }
  } finally {
    await s.stop();
  }
});

test('npm start (plain HTTP) is unchanged: no certificates, no setup page', async () => {
  const port = await freePort();
  const dir = tmp();
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: KEY, PORT: String(port), HOST: '127.0.0.1' };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(output)), 15000);
      child.stdout.on('data', (d) => { output += d; if (output.includes('tutor on')) { clearTimeout(timer); resolve(); } });
      child.stderr.on('data', (d) => { output += d; });
    });
    assert.match(output, new RegExp(`tutor on http://localhost:${port}`));
    assert.doesNotMatch(output, /^HTTPS:|development certificate|Certificate fingerprint/m);
    assert.equal((await fetch(`http://localhost:${port}/api/status`)).status, 200);
    assert.equal((await fetch(`http://localhost:${port}/dev-ca.crt`)).status, 404);
  } finally {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill();
    await exited;
  }
});

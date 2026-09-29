// Shared by the tests that start the real server.
import net from 'node:net';

// A port the OS says is free right now.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().once('error', reject).listen(0, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// The environment for a test server, without the developer's own Qwen/tutor
// settings (spawned test servers also get TUTOR_ENV_FILE=none, so a real .env
// is never read).
export function cleanEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(QWEN_|DASHSCOPE_|TUTOR_)/.test(k)));
}

// A local stand-in for Qwen used by the Listen & Learn flow tests: the example
// writer (chat) and TTS (short real WAV clips). Counts what it was asked.
export async function startListenQwen() {
  const http = await import('node:http');
  const { encodeWav } = await import('../public/voice-core.js');
  const wav = Buffer.from(encodeWav(Float32Array.from({ length: 2400 }, (_, i) => 0.2 * Math.sin(i / 8)), 24000)); // 0.1 s
  const seen = { writer: [], tts: 0, teacherTurns: 0 };
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (b, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/tts') { seen.tts += 1; return json({ output: { audio: { data: wav.toString('base64') } } }); }
    if (req.url === '/teacher/chat/completions') {
      const body = JSON.parse(raw);
      if (/listening material/.test(body.messages[0].content)) {
        const e = JSON.parse(body.messages[1].content);
        seen.writer.push(e.mandarin);
        const content = { sentence_zh: `医生说${e.mandarin}需要检查。`, sentence_en: `The doctor said the ${e.english} needs to be checked.`, usage_en: `Doctors use this word when examining the ${e.english}.`, context_en: `A doctor tells a patient, through the interpreter, that the ${e.english} needs to be checked.` };
        return json({ id: 'w', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
      }
      seen.teacherTurns += 1;
    }
    json({}, 500);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, close: () => new Promise((r) => server.close(r)) };
}

// The real server.js wired to a Qwen stand-in on `qwenPort`, with a fresh database.
export async function startTutorServer(qwenPort, extraEnv = {}) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-flow-'));
  const base = `http://127.0.0.1:${qwenPort}`;
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: 'test-key-flow', QWEN_BASE_URL: `${base}/teacher`, QWEN_ASR_BASE_URL: `${base}/asr`, QWEN_TTS_URL: `${base}/tts`, ...extraEnv };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let out = '';
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(out)), 15000);
    child.stdout.on('data', (d) => { out += d; if (out.includes('tutor on')) { clearTimeout(t); resolve(); } });
    child.stderr.on('data', (d) => { out += d; });
  });
  const stop = () => { const exited = new Promise((r) => child.once('exit', r)); child.kill(); return exited; };
  return { url: `http://localhost:${port}`, stop, output: () => out };
}

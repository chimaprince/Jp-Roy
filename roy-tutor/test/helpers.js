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
// With { interactive: { asrText } } it also plays the Interactive Practice
// parts: the teacher (fixed, valid decisions; every context it gets is kept in
// seen.teacher) and native Qwen ASR (returns asrText; the audio the browser
// uploaded is kept in seen.asrAudio as bytes).
// Every TTS call is counted (seen.tts), with its text (seen.ttsText) and the
// highest number in flight at once (seen.ttsPeak). ttsDelayMs makes each call
// take that long; ttsFail(text, n) can make a call answer 429 (return true).
export async function startListenQwen({ interactive = null, ttsDelayMs = 0, ttsFail = null } = {}) {
  const http = await import('node:http');
  const { encodeWav } = await import('../public/voice-core.js');
  const wav = Buffer.from(encodeWav(Float32Array.from({ length: 2400 }, (_, i) => 0.2 * Math.sin(i / 8)), 24000)); // 0.1 s
  const seen = { writer: [], tts: 0, teacherTurns: 0, teacher: [], asrAudio: [], ttsText: [], ttsInFlight: 0, ttsPeak: 0, tts429: 0 };
  const decision = (over) => ({
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null, notes: '', ...over,
  });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const json = (b, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(b)); };
    if (req.url === '/tts') {
      seen.tts += 1;
      let text = '';
      try { text = JSON.parse(raw).input.text; } catch { /* ignore */ }
      seen.ttsText.push(text);
      seen.ttsInFlight += 1;
      seen.ttsPeak = Math.max(seen.ttsPeak, seen.ttsInFlight);
      if (ttsDelayMs) await new Promise((r) => setTimeout(r, ttsDelayMs));
      seen.ttsInFlight -= 1;
      if (ttsFail?.(text, seen.tts)) { seen.tts429 += 1; return json({ code: 'Throttling.RateQuota', message: 'Requests rate limit exceeded, please try again later.' }, 429); }
      return json({ output: { audio: { data: wav.toString('base64') } } });
    }
    if (req.url === '/teacher/chat/completions') {
      const body = JSON.parse(raw);
      if (/listening material/.test(body.messages[0].content)) {
        const e = JSON.parse(body.messages[1].content);
        seen.writer.push(e.mandarin);
        const content = { sentence_zh: `医生说${e.mandarin}需要检查。`, sentence_en: `The doctor said the ${e.english} needs to be checked.`, usage_en: `Doctors use this word when examining the ${e.english}.`, context_en: `A doctor tells a patient, through the interpreter, that the ${e.english} needs to be checked.` };
        return json({ id: 'w', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(content) } }] });
      }
      seen.teacherTurns += 1;
      if (interactive) {
        const ctx = JSON.parse(body.messages.at(-1).content);
        seen.teacher.push(ctx);
        const level = ctx.roy_said?.asr_evaluation?.level;
        const right = ['high_confidence_correct', 'likely_correct_asr_character_mismatch'].includes(level);
        const d = !ctx.roy_said ? null
          : right ? decision({ correct: true, exercise_complete: true, next_action: 'next_exercise', speech: [{ lang: 'en', text: 'Your syllables were right. Now, what does it mean?', show: null, slow: false }] })
            : decision({ correct: null, needs_retry: true, next_action: 'retry', speech: [{ lang: 'en', text: "I didn't quite catch that. Listen once more:", show: null, slow: false }, { lang: 'zh', text: '硬膜外', show: '硬膜外 — yìng mó wài', slow: true }, { lang: 'en', text: 'Say it again.', show: null, slow: false }] });
        const reply = d ?? decision({ speech: [{ lang: 'en', text: 'Word 1 is epidural.', show: null, slow: false }, { lang: 'zh', text: '硬膜外', show: '硬膜外 — yìng mó wài', slow: true }, { lang: 'en', text: 'Say it after me.', show: null, slow: false }] });
        return json({ id: 't', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(reply) } }] });
      }
    }
    if (interactive && req.url === '/api/v1/services/aigc/multimodal-generation/generation') {
      const found = raw.match(/data:audio\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)/);
      seen.asrAudio.push(found ? Buffer.from(found[1], 'base64') : null);
      return json({ request_id: 'asr-1', output: { choices: [{ message: { role: 'assistant', content: [{ text: interactive.asrText }] } }] } });
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
  const env = { ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'), DASHSCOPE_API_KEY: 'test-key-flow', QWEN_BASE_URL: `${base}/teacher`, QWEN_ASR_BASE_URL: `${base}/asr`, QWEN_TTS_URL: `${base}/tts`, QWEN_TTS_MIN_GAP_MS: '50', QWEN_TTS_RETRY_MS: '50,100,150', ...extraEnv };
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

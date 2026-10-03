// The real page in a real browser (Chromium via Playwright), driving the real
// production ListenController, the real <audio> element and the real server.
// Only the Qwen cloud is replaced (by a local stand-in that returns a short,
// deterministic WAV clip), so no key or network is needed.
//
// Main flow: press "Listen & Learn" once, then touch nothing. Word 1's audio
// plays and ends, the word is completed, a short pause, Word 2 starts by
// itself, plays and ends, a short pause, Word 3 starts by itself. If the page
// waited for a Next click, the waits time out and the test fails.
//
// Every wait fails with a timeline of what the browser did (status line,
// progress line, word card, /api requests, audio 'playing'/'ended' events), so
// a failure says why. The audio element is only observed: play() is the
// browser's own and its promise is returned unchanged.
//
// Skipped only when Playwright or its Chromium is not installed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import { startListenQwen, startTutorServer } from './helpers.js';
import { encodeWav } from '../public/voice-core.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const WAIT_MS = 20000; // one word here takes about 3 s (14 clips of 0.1 s + 1.2 s pause)

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a project dependency */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  } catch { return null; }
}

async function launch(extraArgs = []) {
  const pw = await loadPlaywright();
  if (!pw) return null;
  // The local server is reached directly, never through an outbound proxy.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  try {
    return await pw.chromium.launch({
      env,
      // Test environment only: no autoplay prompt, and muted so a run makes no
      // sound (muted audio still plays and still fires 'ended').
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-proxy-server', ...extraArgs],
    });
  } catch {
    return null;
  }
}

const browser = await launch();
const skip = !browser && 'Playwright/Chromium not installed';
after(() => browser?.close());

// In the page: record every change of the status line, progress line and word
// card, and every audio event, with a time stamp.
function recorder() {
  const t0 = performance.now();
  window.timeline = [];
  const note = (kind, text) => window.timeline.push({ t: Math.round(performance.now() - t0), kind, text });
  const originalPlay = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function play(...args) {
    window.player = this; // the page's audio element (for the stray-event test)
    if (!this.observed) {
      this.observed = true;
      for (const e of ['playing', 'ended', 'error']) {
        this.addEventListener(e, () => {
          note('audio', e);
          // Which Listen & Learn line was on screen when this clip played.
          if (e === 'playing') note('clip', `${document.getElementById('listen-state')?.textContent ?? ''} | ${document.getElementById('listen-now')?.textContent ?? ''}`);
        });
      }
    }
    return originalPlay.apply(this, args);
  };
  const watch = (id, kind) => {
    const el = document.getElementById(id);
    let last = null;
    const check = () => { if (el.textContent !== last) { last = el.textContent; note(kind, last); } };
    new MutationObserver(check).observe(el, { childList: true, characterData: true, subtree: true });
    check();
  };
  // The tutor's voice must come from the server (Qwen), never the browser's
  // own speech engines: any use of them is recorded (and fails the tests).
  const forbidden = (name) => class { constructor() { note('forbidden', name); } start() {} stop() {} abort() {} };
  window.SpeechRecognition = forbidden('SpeechRecognition');
  window.webkitSpeechRecognition = forbidden('webkitSpeechRecognition');
  if (window.speechSynthesis) window.speechSynthesis.speak = () => note('forbidden', 'speechSynthesis.speak');
  document.addEventListener('DOMContentLoaded', () => {
    watch('listen-state', 'state');
    watch('progress', 'progress');
    watch('card-position', 'card');
    watch('listen-where', 'where');
    watch('mic-state', 'mic');
    watch('heard', 'heard');
    watch('status', 'status');
  });
  document.addEventListener('click', (e) => note('click', e.target.closest('button')?.id ?? ''), true);
}

async function openPage(url, { route, using = browser } = {}) {
  const page = await using.newPage();
  const requests = [];
  const bodies = []; // everything the server sent the page (checked for the key)
  page.on('response', (r) => { r.body().then((b) => bodies.push(b.toString('latin1'))).catch(() => {}); });
  page.on('request', (r) => {
    const u = r.url().replace(url, '');
    if (u.startsWith('/api/')) requests.push({ method: r.method(), url: u, body: r.postData() });
  });
  page.on('pageerror', (err) => requests.push({ method: 'PAGE ERROR', url: err.message }));
  if (route) await page.route('**/api/voice/speech/**', route);
  await page.addInitScript(recorder);
  await page.goto(url);
  const timeline = () => page.evaluate(() => window.timeline);
  const dump = async () => {
    const lines = (await timeline()).map((e) => `${String(e.t).padStart(6)} ${e.kind.padEnd(8)} ${e.text}`);
    const reqs = requests.map((r) => `${r.method} ${r.url}${r.body ? ` ${r.body}` : ''}`);
    return `\n--- browser timeline (ms) ---\n${lines.slice(-80).join('\n')}\n--- api requests ---\n${reqs.slice(-40).join('\n')}`;
  };
  // Waits until something shows up in the timeline; on timeout, fails with it.
  const waitFor = async (what, check) => {
    const end = Date.now() + WAIT_MS;
    for (;;) {
      const found = (await timeline()).find(check);
      if (found) return found;
      if (Date.now() > end) assert.fail(`timed out waiting for: ${what}${await dump()}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  const texts = async (kind) => (await timeline()).filter((e) => e.kind === kind).map((e) => e.text);
  const completes = () => requests.filter((r) => r.url === '/api/listen/complete').map((r) => JSON.parse(r.body));
  return { page, requests, bodies, timeline, dump, waitFor, texts, completes };
}

const state = (re) => (e) => e.kind === 'state' && re.test(e.text);
const place = async (url) => (await (await fetch(`${url}/api/status`)).json()).position;

async function withServer(fn, qwenOptions) {
  const q = await startListenQwen(qwenOptions);
  const s = await startTutorServer(q.port);
  try { await fn(s, q); } finally { await s.stop(); await q.close(); }
}

test('browser: Listen & Learn plays Word 1 → Word 2 → Word 3 by itself (no Next click)', { skip }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    try {
      // 1. Word 1 is displayed.
      await p.waitFor('the page shows Word 1', (e) => e.kind === 'progress' && /Progress: Word 1 of 385/.test(e.text));
      await p.waitFor('the Word 1 card', (e) => e.kind === 'card' && /\b1\b/.test(e.text));
      assert.equal(await p.page.textContent('#version'), `v${pkg.version}`);

      // 2. Listen mode starts (the only click).
      await p.page.click('#mode-listen');
      assert.equal(await p.page.isVisible('#listen'), true);

      // 3. Word 1 plays, its audio really ends, and it is completed.
      const w1 = await p.waitFor('Word 1 playing', state(/^Playing Word 1 · 1 of \d+$/));
      const audioEnded = await p.waitFor('a real audio "ended" event in Word 1', (e) => e.kind === 'audio' && e.text === 'ended' && e.t > w1.t);
      assert.ok(audioEnded);
      const gap1 = await p.waitFor('Word 1 completed', state(/^Word 1 complete\. Moving to Word 2…$/));
      const tl = await p.timeline();
      const lastW1Step = tl.filter((e) => e.kind === 'state' && /^Playing Word 1 · /.test(e.text)).at(-1).text;
      const [, n, of] = lastW1Step.match(/(\d+) of (\d+)$/);
      assert.equal(n, of, 'every step of Word 1 played before it was completed');
      const endedInW1 = tl.filter((e) => e.kind === 'audio' && e.text === 'ended' && e.t > w1.t && e.t <= gap1.t).length;
      assert.ok(endedInW1 >= Number(of), `each of Word 1's ${of} clips ended (saw ${endedInW1})`);
      assert.deepEqual(p.completes()[0], { position: 1, review: false });

      // 4. Word 2 appears without clicking Next, after a short pause.
      const w2 = await p.waitFor('Word 2 playing (no click)', state(/^Playing Word 2 · 1 of \d+$/));
      assert.ok(w2.t - gap1.t >= 1000, `a short pause between words (${w2.t - gap1.t} ms)`);
      await p.waitFor('the Word 2 card', (e) => e.kind === 'where' && /^Now teaching: Word 2 of 385/.test(e.text));

      // 5. Word 2 plays to the end and is completed.
      const gap2 = await p.waitFor('Word 2 completed', state(/^Word 2 complete\. Moving to Word 3…$/));
      assert.ok(gap2.t > w2.t);
      assert.deepEqual(p.completes()[1], { position: 2, review: false });

      // 6. Word 3 appears without clicking Next.
      await p.waitFor('Word 3 playing (no click)', state(/^Playing Word 3 · 1 of \d+$/));
      await p.page.click('#listen-pause');

      // 7. The progress / current place follows, in the page and on the server.
      assert.deepEqual((await p.texts('progress')).filter((t) => /Word \d/.test(t)),
        ['Progress: Word 1 of 385', 'Progress: Word 2 of 385', 'Progress: Word 3 of 385']);
      assert.equal(await place(s.url), 3, 'the shared place (Interactive Practice too) is Word 3');

      const clicks = await p.texts('click');
      assert.deepEqual(clicks, ['mode-listen', 'listen-pause'], `no Next (or other) click: ${clicks}`);
      assert.ok(!(await p.texts('state')).some((t) => /Finished this word|→ Next for the next word/.test(t)), 'the old "press Next" message never shows');
      assert.ok(p.requests.some((r) => r.url === '/api/listen?position=2') && p.requests.some((r) => r.url === '/api/listen?position=3'), 'the next lessons were requested');
      assert.ok(q.seen.tts > 0, 'the audio came from the Qwen TTS stand-in');

      // The lesson was taught (Qwen-written explanation, usage, example, situation), not just read.
      const shown = await p.texts('where');
      assert.ok(shown.some((t) => t.startsWith('Now teaching: Word 1 of 385')) && shown.some((t) => t.startsWith('Now teaching: Word 2 of 385')));
      const lesson1 = (await (await fetch(`${s.url}/api/listen?audio=0&position=1`)).json());
      assert.equal(lesson1.teaching.source, 'teacher', 'written by the AI teacher (the curriculum has no examples)');
      assert.deepEqual(lesson1.steps.map((x) => x.kind), ['intro', 'term', 'explain', 'sentence', 'sentence-en', 'dialogue', 'dialogue-en', 'recap']);
      assert.ok(q.seen.ttsText.includes('我们来学一个医学词语：硬膜外。'), 'the teacher introduces the word in Mandarin');
      assert.ok(q.seen.ttsText.includes('再听一次：硬膜外。医生说硬膜外需要检查。'), 'and recaps the word and the sentence in Mandarin');
      assert.ok(q.seen.ttsText.some((t) => t.startsWith('Epidural. In medical communication this term means epidural. Doctors use this word')), 'explanation + practical usage spoken');
      assert.ok(q.seen.ttsText.includes('医生说硬膜外需要检查。'), 'the example sentence spoken in Mandarin');
      assert.ok(q.seen.ttsText.some((t) => /^That means: The doctor said the epidural needs to be checked\. A doctor tells a patient, through the interpreter/.test(t)), 'translation + interpreter situation spoken');
      assert.ok(!q.seen.ttsText.some((t) => /yìng|ying mo wai/i.test(t)), 'pinyin never sent to the voice');

      // Qwen TTS load: lines are requested one at a time as they are played
      // (plus one line of look-ahead), each distinct line exactly once.
      const lines = async (n) => (await (await fetch(`${s.url}/api/listen?audio=0&position=${n}`)).json()).steps.map((x) => x.text);
      const w12 = new Set([...(await lines(1)), ...(await lines(2))]);
      await p.page.waitForTimeout(300); // let a look-ahead request that is still on its way land
      assert.equal(q.seen.ttsPeak, 1, 'never more than one Qwen TTS request at a time');
      assert.equal(new Set(q.seen.ttsText).size, q.seen.ttsText.length, `no line was generated twice: ${q.seen.ttsText.join(' | ')}`);
      assert.ok([...w12].every((t) => q.seen.ttsText.includes(t)), 'every line of Words 1 and 2 was generated');
      assert.ok(q.seen.tts <= w12.size + 2, `3 words played → ${q.seen.tts} TTS requests (Words 1-2 have ${w12.size} distinct lines; Word 3 had just started)`);
      assert.ok(w12.size <= 16, `Words 1 and 2 need only ${w12.size} TTS requests (at most 8 each)`);
    } finally {
      await p.page.close();
    }
  }, { ttsDelayMs: 60 });
});

const speechRequests = (p) => p.requests.filter((r) => r.url.startsWith('/api/voice/speech/')).map((r) => r.url);

test('browser: Pause does not advance or request audio; Play resumes the same line from the audio it already has', { skip }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      const step3 = await p.waitFor('Word 1 step 3', state(/^Playing Word 1 · 3 of \d+$/));
      await p.waitFor('its audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > step3.t);
      await p.page.click('#listen-pause');
      await p.waitFor('paused', state(/^Paused at Word 1\./));
      await p.page.waitForTimeout(400); // a look-ahead already sent may land
      const qwenAtPause = q.seen.tts;
      const downloadsAtPause = speechRequests(p).length;
      await p.page.waitForTimeout(3000); // longer than a whole word would take
      const after = (await p.timeline()).filter((e) => e.kind === 'state').at(-1).text;
      assert.match(after, /^Paused at Word 1\./, 'still paused at Word 1');
      assert.equal(p.completes().length, 0, 'nothing completed while paused');
      assert.equal(await place(s.url), 1);
      assert.equal(q.seen.tts, qwenAtPause, 'no Qwen TTS request while paused');

      const resume = Date.now();
      await p.page.click('#listen-play');
      const resumed = await p.waitFor('Word 1 resumed at step 3', (e) => e.kind === 'state' && e.text.startsWith('Playing Word 1 · 3 of') && e.t > step3.t + 100);
      await p.waitFor('its audio plays again', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > resumed.t);
      assert.equal(speechRequests(p).length, downloadsAtPause, 'the interrupted line replays from the audio the page already had');
      assert.equal(q.seen.tts, qwenAtPause, 'and Qwen is not asked again');
      assert.ok(Date.now() - resume < 5000);
      await p.waitFor('then Word 2 by itself', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
      assert.equal(await place(s.url), 2);
      assert.equal(new Set(q.seen.ttsText).size, q.seen.ttsText.length, 'no line generated twice');
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Repeat replays the current word from cached audio and does not advance', { skip }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      const mid = await p.waitFor('Word 1 step 4', state(/^Playing Word 1 · 4 of \d+$/));
      await p.waitFor('its audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > mid.t);
      const heard = speechRequests(p);
      const qwenBefore = q.seen.tts;
      await p.page.click('#listen-repeat');
      const again = await p.waitFor('Word 1 from its first step again', (e) => e.kind === 'state' && /^Playing Word 1 · 1 of/.test(e.text) && e.t > mid.t);
      assert.equal(p.completes().length, 0, 'Repeat did not complete Word 1');
      assert.equal(await place(s.url), 1, 'Repeat did not move the place');
      const between = (await p.timeline()).filter((e) => e.kind === 'state' && e.t > mid.t && e.t <= again.t).map((e) => e.text);
      assert.ok(!between.some((t) => /Word 2/.test(t)), `no Word 2 before the replay: ${between}`);
      const replayed = await p.waitFor('the replay reaches step 4 again', (e) => e.kind === 'state' && e.t > again.t && e.text.startsWith('Playing Word 1 · 4 of'));
      await p.waitFor('its audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > replayed.t);
      assert.deepEqual(speechRequests(p).slice(0, heard.length), heard);
      assert.equal(speechRequests(p).filter((u) => heard.includes(u)).length, heard.length, 'lines 1-4 were not downloaded again');
      assert.ok(q.seen.tts <= qwenBefore + 1, 'and not generated again (at most the next new line was asked for)');
      // After the replay finishes, it goes on as usual.
      await p.waitFor('then Word 2', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
      assert.equal(new Set(q.seen.ttsText).size, q.seen.ttsText.length, 'no line generated twice');
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Next skips at once; Word 1 audio still being generated never plays over Word 2 (stale request)', { skip }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    try {
      // Slow voice (400 ms per line): press Next the moment Word 1's third line
      // starts, while its audio is still being generated.
      await p.page.evaluate(() => {
        const el = document.getElementById('listen-state');
        const obs = new MutationObserver(() => {
          if (/^Playing Word 1 · 3 of/.test(el.textContent)) { obs.disconnect(); window.nextAt = performance.now(); document.getElementById('listen-next').click(); }
        });
        obs.observe(el, { childList: true, characterData: true, subtree: true });
      });
      await p.page.click('#mode-listen');
      const line = await p.waitFor('Word 1 step 3', state(/^Playing Word 1 · 3 of \d+$/));
      const click = (await p.waitFor('the Next click', (e) => e.kind === 'click' && e.text === 'listen-next')).t;
      assert.ok(click - line.t < 50, 'Next was pressed as the line started');
      assert.ok(!(await p.timeline()).some((e) => e.kind === 'clip' && e.t >= line.t && e.t <= click), 'its audio had not started yet');
      await p.waitFor('Word 2 after Next', (e) => e.kind === 'state' && e.t > click && /^Playing Word 2 · 1 of/.test(e.text));
      const w2Audio = await p.waitFor('Word 2 audio playing', (e) => e.kind === 'clip' && e.t > click);
      await p.page.waitForTimeout(1200); // the stale Word 1 audio has certainly arrived by now
      await p.page.click('#listen-pause');
      const clips = (await p.timeline()).filter((e) => e.kind === 'clip' && e.t > click);
      assert.ok(clips.every((c) => /Word 2/.test(c.text)), `only Word 2 audio played after Next: ${clips.map((c) => c.text).join(' | ')}`);
      assert.match(w2Audio.text, /^Playing Word 2 · 1 of/);
      assert.equal(p.completes().length, 0, 'the skipped Word 1 was not completed');
      assert.equal(await place(s.url), 1, 'the place stays at the skipped word');
      assert.match(await p.page.textContent('#listen-where'), /^Now playing: Word 2 of 385, ahead of your place · your place stays at Word 1 \(skipped, not completed yet\)/, 'the page says clearly which word plays and where the place is');
      assert.match(await p.page.textContent('#progress'), /Progress: Word 1 of 385/);
      assert.equal(q.seen.ttsPeak, 1, 'one Qwen TTS request at a time throughout');
      assert.equal(new Set(q.seen.ttsText).size, q.seen.ttsText.length, 'no line generated twice');
    } finally {
      await p.page.close();
    }
  }, { ttsDelayMs: 400 });
});

test('browser: Qwen TTS 429 (rate limit): the server backs off and retries one at a time, then the page pauses with a clear message; ▶ Play retries and it carries on', { skip }, async () => {
  let limited = true;
  const isTarget = (t) => t.startsWith('Epidural. '); // Word 1's teaching (English) segment
  // Qwen answers 429 for that line while `limited` is on.
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      const stopped = await p.waitFor('the rate-limit pause', state(/^Audio failed: Qwen's voice is busy right now \(rate limit\)\. Word 1 is not complete\. Wait a moment, then ↻ Retry\.$/));
      assert.match(await p.page.textContent('#notice'), /temporarily rate-limited/);
      const tries = q.seen.ttsText.filter(isTarget).length;
      assert.equal(tries, 4, 'the first request plus 3 spaced retries, then it stopped');
      assert.equal(q.seen.ttsPeak, 1, 'retries were never sent in parallel');
      await p.page.waitForTimeout(1000);
      assert.equal(q.seen.ttsText.filter(isTarget).length, 4, 'no retry loop in the background');
      assert.deepEqual((await p.timeline()).filter((e) => e.kind === 'state' && e.t > stopped.t), [], 'nothing moved on');
      assert.equal(p.completes().length, 0, 'Word 1 was not completed');
      assert.equal(await place(s.url), 1);

      limited = false; // the rate limit has cleared
      await p.page.click('#listen-play');
      await p.waitFor('Word 1 completed after the retry', state(/^Word 1 complete\. Moving to Word 2…$/));
      await p.waitFor('then Word 2 by itself', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.equal(q.seen.ttsText.filter(isTarget).length, 5, 'one more request for that line after Play');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
      assert.equal(await place(s.url), 2);
    } finally {
      await p.page.close();
    }
  }, { ttsFail: (text) => limited && isTarget(text) });
});

test('browser: an audio failure stops on that line with a clear error, does not complete the word, and ▶ Play retries it', { skip }, async () => {
  let speech = 0;
  // The server's audio for Word 1's second line fails once (as if Qwen TTS failed).
  const route = (r) => (++speech === 2 ? r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'TTS failed', code: 'tts_failed' }) }) : r.continue());
  await withServer(async (s) => {
    const p = await openPage(s.url, { route });
    try {
      await p.page.click('#mode-listen');
      const stopped = await p.waitFor('the failed line stops the player', state(/^Audio failed\. Word 1 is not complete\. ↻ Retry plays it again · → Next skips it\.$/));
      assert.match(await p.page.textContent('#notice'), /voice \(Qwen\) is not available/, 'a clear error is shown');
      assert.equal(await p.page.textContent('#listen-play'), '↻ Retry', 'the Play button offers Retry');
      await p.page.waitForTimeout(2500); // longer than the rest of the word would take
      const later = (await p.timeline()).filter((e) => e.kind === 'state' && e.t > stopped.t);
      assert.deepEqual(later, [], 'nothing moves on by itself after the failure');
      assert.equal(p.completes().length, 0, 'no completion was sent for Word 1');
      assert.equal(await place(s.url), 1, 'the place stays at Word 1');
      assert.match(await p.page.textContent('#progress'), /Word 1 of 385/);

      await p.page.click('#listen-play'); // retry
      const retried = await p.waitFor('the failed line again', (e) => e.kind === 'state' && e.t > stopped.t && /^Playing Word 1 · 2 of/.test(e.text));
      await p.waitFor('its audio really plays this time', (e) => e.kind === 'audio' && e.text === 'ended' && e.t > retried.t);
      await p.waitFor('Word 1 completed after the retry', state(/^Word 1 complete\. Moving to Word 2…$/));
      await p.waitFor('then Word 2 by itself', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
      assert.equal(await place(s.url), 2);
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Exit mid-word completes nothing; reload keeps the place: after Words 1-2, a reloaded page is at Word 3 and Listen & Learn goes on from Word 3', { skip }, async () => {
  await withServer(async (s) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      await p.waitFor('Word 3 playing (no click)', state(/^Playing Word 3 · 2 of/));
      await p.page.click('#listen-exit'); // leave in the middle of Word 3
      assert.deepEqual(p.completes().map((c) => c.position), [1, 2], 'Words 1 and 2 saved as completed; Word 3 (left mid-way) not');
      await p.waitFor('home shows Word 3', (e) => e.kind === 'progress' && e.text === 'Progress: Word 3 of 385');
    } finally {
      await p.page.close();
    }
    const again = await openPage(s.url); // a fresh page, as after a reload or on the phone
    try {
      await again.waitFor('the reloaded page shows Word 3', (e) => e.kind === 'progress' && e.text === 'Progress: Word 3 of 385');
      await again.page.click('#mode-listen');
      await again.waitFor('Listen & Learn continues at Word 3', state(/^Playing Word 3 · 1 of/));
      assert.match(await again.page.textContent('#listen-where'), /^Now teaching: Word 3 of 385/);
      await again.page.click('#listen-pause');
      assert.equal(await place(s.url), 3);
    } finally {
      await again.page.close();
    }
  });
});

test('browser: stray, duplicate or stale "ended" events cannot skip a clip or a word (only the real end of the playing clip counts)', { skip }, async () => {
  await withServer(async (s) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      const line2 = await p.waitFor('Word 1 clip 2', state(/^Playing Word 1 · 2 of \d+$/));
      await p.waitFor('its audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > line2.t);
      // Three fake "ended" events while the 1-second clip is still playing.
      await p.page.evaluate(() => { for (let i = 0; i < 3; i++) window.player.dispatchEvent(new Event('ended')); });
      await p.page.waitForTimeout(300);
      const last = (await p.timeline()).filter((e) => e.kind === 'state').at(-1).text;
      assert.match(last, /^Playing Word 1 · 2 of/, 'still on clip 2');
      // Let it play on; every clip of Word 1 plays, in order, then Word 2 once.
      await p.waitFor('Word 2 by itself', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      const w1 = (await p.texts('state')).filter((t) => /^Playing Word 1 · /.test(t)).map((t) => Number(t.match(/· (\d+) of/)[1]));
      assert.deepEqual(w1, Array.from({ length: w1.length }, (_, i) => i + 1), `no clip skipped: ${w1}`);
      assert.equal((await p.texts('state')).filter((t) => /^Playing Word 2 · 1 of/.test(t)).length, 1, 'Word 2 started once');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }], 'Word 1 completed once');
    } finally {
      await p.page.close();
    }
  }, { clipSeconds: 1 });
});

// The whole sequence in one sitting, as Roy would use it (Phase 22 of the brief).
test('browser: full sequence: auto-advance 1→2→3, Pause, Resume, Repeat, finish once, Next, Exit, Interactive Practice at the same place', { skip }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url);
    const lastState = async () => (await p.timeline()).filter((e) => e.kind === 'state').at(-1)?.text;
    try {
      // 1-2. Home page, Word 1.
      await p.waitFor('home shows Word 1', (e) => e.kind === 'progress' && e.text === 'Progress: Word 1 of 385');
      // 3-5. Listen & Learn; Word 1 audio plays and really finishes.
      await p.page.click('#mode-listen');
      const w1 = await p.waitFor('Word 1 playing', state(/^Playing Word 1 · 1 of/));
      await p.waitFor('Word 1 audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > w1.t);
      await p.waitFor('Word 1 finished', state(/^Word 1 complete\. Moving to Word 2…$/));
      // 6-8. Word 2 and Word 3 by themselves.
      const w2 = await p.waitFor('Word 2 playing', state(/^Playing Word 2 · 1 of/));
      await p.waitFor('Word 2 audio playing', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > w2.t);
      await p.waitFor('Word 3 playing', state(/^Playing Word 3 · 2 of/));
      // 9-10. Pause: no progress.
      await p.page.click('#listen-pause');
      const paused = await p.waitFor('paused', state(/^Paused at Word 3\./));
      await p.page.waitForTimeout(2500);
      assert.match(await lastState(), /^Paused at Word 3\./, 'still paused');
      assert.equal(await place(s.url), 3, 'pause did not advance');
      // 11-12. Resume: the audio continues in Word 3.
      await p.page.click('#listen-play');
      const resumed = await p.waitFor('resumed in Word 3', (e) => e.kind === 'state' && e.t > paused.t && /^Playing Word 3 · /.test(e.text));
      await p.waitFor('audio continues', (e) => e.kind === 'audio' && e.text === 'playing' && e.t > resumed.t);
      // 13-15. Repeat: Word 3 from its first line, no advance.
      await p.waitFor('a later line of Word 3', (e) => e.kind === 'state' && e.t > resumed.t && /^Playing Word 3 · ([4-9]|1\d) of/.test(e.text));
      await p.page.click('#listen-repeat');
      const again = await p.waitFor('Word 3 again from the start', (e) => e.kind === 'state' && e.t > resumed.t && e.text.startsWith('Playing Word 3 · 1 of'));
      assert.equal(await place(s.url), 3, 'repeat did not advance');
      assert.equal(p.completes().filter((c) => c.position === 3).length, 0);
      // 16-17. Let it finish: exactly one advance.
      await p.waitFor('Word 3 finished', (e) => e.kind === 'state' && e.t > again.t && e.text === 'Word 3 complete. Moving to Word 4…');
      const w4 = await p.waitFor('Word 4 playing', state(/^Playing Word 4 · 1 of/));
      assert.deepEqual(p.completes().map((c) => c.position), [1, 2, 3], 'each word completed exactly once');
      assert.equal(await place(s.url), 4);
      // 18-20. Next: skips exactly one word; the skipped word is not completed.
      await p.page.click('#listen-next');
      await p.waitFor('Word 5 after Next', (e) => e.kind === 'state' && e.t > w4.t && /^Playing Word 5 · 1 of/.test(e.text));
      await p.page.click('#listen-pause');
      assert.ok(!(await p.texts('state')).some((t) => /Word 6/.test(t)), 'only one word skipped');
      assert.deepEqual(p.completes().map((c) => c.position), [1, 2, 3], 'Word 4 (skipped) was not completed');
      assert.equal(await place(s.url), 4, 'the place is the skipped Word 4');
      // 21-23. Exit, then Interactive Practice starts at the same place.
      await p.page.click('#listen-exit');
      await p.waitFor('home shows Word 4', (e) => e.kind === 'progress' && e.text === 'Progress: Word 4 of 385');
      await p.page.click('#mode-interactive');
      await p.waitFor('the teacher is asked to start the lesson', () => q.seen.teacher.some((c) => c.event === 'session_start'));
      await p.waitFor('Interactive Practice speaks', (e) => e.kind === 'mic' && e.text === 'TEACHER SPEAKING');
      assert.match(await p.page.textContent('#card-position'), /^Word 4\b/, 'the card shows Word 4');
      const start = q.seen.teacher.find((c) => c.event === 'session_start');
      assert.equal(start.current_entry.position, 4, 'Interactive Practice teaches Word 4');
      assert.equal(start.course.curriculum_position, 4);
      assert.deepEqual(await p.texts('forbidden'), [], 'no browser speech engines');
    } finally {
      await p.page.close();
    }
  }, { interactive: { asrText: '硬膜外' } });
});

// A spoken answer through the real page: Chromium's fake microphone plays a
// recorded WAV (a stand-in for Roy's voice), the page records it, converts it
// to 16 kHz WAV and uploads it; the server sends it to (stand-in) Qwen ASR; the
// transcript goes through the ASR-aware evaluation to the teacher; the reply is
// spoken by (stand-in) Qwen TTS and played by the page.
const micDir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-mic-'));
const micFile = path.join(micDir, 'roy.wav');
{
  const rate = 48000;
  const voiceLike = (t) => (0.35 + 0.25 * Math.sin(2 * Math.PI * 4 * t)) * (Math.sin(2 * Math.PI * 190 * t) + 0.5 * Math.sin(2 * Math.PI * 380 * t) + 0.25 * Math.sin(2 * Math.PI * 760 * t)) / 1.75;
  const samples = Float32Array.from({ length: rate * 6 }, (_, i) => { const t = i / rate; return t > 0.5 && t < 2.3 ? 0.6 * voiceLike(t) : 0; });
  fs.writeFileSync(micFile, Buffer.from(encodeWav(samples, rate)));
}
const micBrowser = browser && await launch(['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`]);
after(() => micBrowser?.close());

test('browser: Interactive Practice by voice: microphone → server → Qwen ASR → evaluation → teacher → Qwen TTS → playback', { skip: !micBrowser && 'Playwright/Chromium not installed' }, async () => {
  await withServer(async (s, q) => {
    const p = await openPage(s.url, { using: micBrowser });
    try {
      await p.page.click('#mode-interactive');
      // The teacher's opening lines are Qwen TTS audio played by the page.
      const listening = await p.waitFor('the page listens after the teacher spoke', (e) => e.kind === 'mic' && e.text === 'LISTENING');
      const teacherAudio = (await p.timeline()).filter((e) => e.kind === 'audio' && e.text === 'ended' && e.t < listening.t).length;
      assert.ok(teacherAudio >= 3, `the teacher's 3 lines played to their end first (${teacherAudio})`);
      // Roy's answer is recorded, sent, recognised, and shown.
      await p.waitFor('the transcript from Qwen ASR is shown', (e) => e.kind === 'heard' && e.text.includes('磨膜外'));
      assert.equal(q.seen.asrAudio.length, 1, 'one recording went to Qwen ASR');
      const wav = q.seen.asrAudio[0];
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF', 'the recording reached ASR as WAV');
      assert.equal(wav.readUInt32LE(24), 16000, '16 kHz');
      const pcm = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length - (wav.length % 2)));
      const seconds = pcm.length / 16000;
      const peak = pcm.reduce((m, v) => Math.max(m, Math.abs(v)), 0) / 32768;
      assert.ok(seconds > 1.5, `the whole answer was recorded (${seconds.toFixed(1)} s)`);
      assert.ok(peak > 0.05, `real sound, not silence (peak ${peak.toFixed(2)})`);
      // The engine judged the transcript with the lesson context, and the teacher got it.
      await p.waitFor('the teacher replied', () => q.seen.teacher.some((c) => c.roy_said));
      const turn = q.seen.teacher.find((c) => c.roy_said);
      assert.equal(turn.roy_said.text, '磨膜外');
      assert.match(turn.roy_said.input, /^voice/);
      assert.equal(turn.roy_said.asr_evaluation.level, 'uncertain', '磨膜外 for 硬膜外: not called right, not called wrong');
      assert.equal(turn.current_entry.mandarin, '硬膜外');
      // The reply is spoken (Qwen TTS) and played, then the page listens again.
      await p.waitFor('the reply played and the page listens again', (e) => e.kind === 'mic' && /^LISTENING/.test(e.text) && e.t > listening.t);
      assert.ok(q.seen.ttsText.includes("I didn't quite catch that. Listen once more:"), 'the reply went to Qwen TTS');
      // One teacher reply → one TTS request per line; 硬膜外 (said in both replies) came from the cache.
      assert.deepEqual([...q.seen.ttsText].sort(), ['Word 1 is epidural.', '硬膜外', 'Say it after me.', "I didn't quite catch that. Listen once more:", 'Say it again.'].sort());
      assert.equal(q.seen.ttsPeak, 1, 'one Qwen TTS request at a time');
      assert.deepEqual(await p.texts('forbidden'), [], 'no SpeechRecognition / speechSynthesis in the browser');
      assert.ok(!p.bodies.some((b) => b.includes('test-key-flow')), 'the API key never reached the browser');
      assert.equal(await place(s.url), 1, 'an uncertain answer does not complete anything');
    } finally {
      await p.page.close();
    }
  }, { interactive: { asrText: '磨膜外' } });
});

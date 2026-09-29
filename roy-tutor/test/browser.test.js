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
import { readFileSync } from 'node:fs';
import { startListenQwen, startTutorServer } from './helpers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const WAIT_MS = 20000; // one word here takes about 3 s (14 clips of 0.1 s + 1.2 s pause)

async function loadPlaywright() {
  try { return await import('playwright'); } catch { /* not a project dependency */ }
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return createRequire(path.join(root, 'noop.js'))('playwright');
  } catch { return null; }
}

async function launch() {
  const pw = await loadPlaywright();
  if (!pw) return null;
  // The local server is reached directly, never through an outbound proxy.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  try {
    return await pw.chromium.launch({
      env,
      // Test environment only: no autoplay prompt, and muted so a run makes no
      // sound (muted audio still plays and still fires 'ended').
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-proxy-server'],
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
    if (!this.observed) {
      this.observed = true;
      for (const e of ['playing', 'ended', 'error']) this.addEventListener(e, () => note('audio', e));
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
  document.addEventListener('DOMContentLoaded', () => {
    watch('listen-state', 'state');
    watch('progress', 'progress');
    watch('card-position', 'card');
    watch('listen-where', 'where');
  });
  document.addEventListener('click', (e) => note('click', e.target.closest('button')?.id ?? ''), true);
}

async function openPage(url, { route } = {}) {
  const page = await browser.newPage();
  const requests = [];
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
  return { page, requests, timeline, dump, waitFor, texts, completes };
}

const state = (re) => (e) => e.kind === 'state' && re.test(e.text);
const place = async (url) => (await (await fetch(`${url}/api/status`)).json()).position;

async function withServer(fn) {
  const q = await startListenQwen();
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
      const gap1 = await p.waitFor('Word 1 completed', state(/^Completed Word 1\. Starting Word 2…$/));
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
      await p.waitFor('the Word 2 card', (e) => e.kind === 'where' && /^Word 2 of 385/.test(e.text));

      // 5. Word 2 plays to the end and is completed.
      const gap2 = await p.waitFor('Word 2 completed', state(/^Completed Word 2\. Starting Word 3…$/));
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
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Pause does not advance; Play resumes and continues to the next word', { skip }, async () => {
  await withServer(async (s) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      await p.waitFor('Word 1 step 3', state(/^Playing Word 1 · 3 of \d+$/));
      await p.page.click('#listen-pause');
      await p.waitFor('paused', state(/^Paused at Word 1\./));
      await p.page.waitForTimeout(3000); // longer than a whole word would take
      const after = (await p.timeline()).filter((e) => e.kind === 'state').at(-1).text;
      assert.match(after, /^Paused at Word 1\./, 'still paused at Word 1');
      assert.equal(p.completes().length, 0, 'nothing completed while paused');
      assert.equal(await place(s.url), 1);

      await p.page.click('#listen-play');
      await p.waitFor('Word 1 resumed', (e) => e.kind === 'state' && /^Playing Word 1 · [3-9]/.test(e.text) && e.t > 0);
      await p.waitFor('then Word 2 by itself', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
      assert.equal(await place(s.url), 2);
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Repeat replays the current word and does not advance', { skip }, async () => {
  await withServer(async (s) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      const mid = await p.waitFor('Word 1 step 4', state(/^Playing Word 1 · 4 of \d+$/));
      await p.page.click('#listen-repeat');
      const again = await p.waitFor('Word 1 from its first step again', (e) => e.kind === 'state' && /^Playing Word 1 · 1 of/.test(e.text) && e.t > mid.t);
      assert.equal(p.completes().length, 0, 'Repeat did not complete Word 1');
      assert.equal(await place(s.url), 1, 'Repeat did not move the place');
      const between = (await p.timeline()).filter((e) => e.kind === 'state' && e.t > mid.t && e.t <= again.t).map((e) => e.text);
      assert.ok(!between.some((t) => /Word 2/.test(t)), `no Word 2 before the replay: ${between}`);
      // After the replay finishes, it goes on as usual.
      await p.waitFor('then Word 2', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.deepEqual(p.completes(), [{ position: 1, review: false }]);
    } finally {
      await p.page.close();
    }
  });
});

test('browser: Next skips to the next word at once (the skipped word is not completed)', { skip }, async () => {
  await withServer(async (s) => {
    const p = await openPage(s.url);
    try {
      await p.page.click('#mode-listen');
      await p.waitFor('Word 1 step 2', state(/^Playing Word 1 · 2 of \d+$/));
      await p.page.click('#listen-next');
      await p.waitFor('Word 2 after Next', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      assert.equal(p.completes().length, 0, 'the skipped Word 1 was not completed');
      assert.equal(await place(s.url), 1, 'the place stays at the skipped word');
    } finally {
      await p.page.close();
    }
  });
});

test('browser: an audio failure does not complete the word', { skip }, async () => {
  let speech = 0;
  // The server's audio for Word 1's second line fails (as if Qwen TTS failed).
  const route = (r) => (++speech === 2 ? r.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'TTS failed', code: 'tts_failed' }) }) : r.continue());
  await withServer(async (s) => {
    const p = await openPage(s.url, { route });
    try {
      await p.page.click('#mode-listen');
      // Word 1 carries on (the failed line's text stays on screen) ...
      await p.waitFor('Word 1 reaches its last step', (e) => e.kind === 'state' && /^Playing Word 1 · (\d+) of \1$/.test(e.text));
      // ... then says it was not completed, and moves on without completing it.
      await p.waitFor('the "not complete" status', state(/^Word 1 was not heard in full, so it is not marked complete\. Starting Word 2…$/));
      await p.waitFor('Word 2 playing', state(/^Playing Word 2 · 1 of/));
      await p.page.click('#listen-pause');
      const states = await p.texts('state');
      assert.ok(!states.some((t) => /^Completed Word 1/.test(t)), states.join(' | '));
      assert.equal(p.completes().length, 0, 'no completion was sent for Word 1');
      assert.equal(await place(s.url), 1, 'the place stays at Word 1');
      assert.match(await p.page.textContent('#progress'), /Word 1 of 385/);
    } finally {
      await p.page.close();
    }
  });
});

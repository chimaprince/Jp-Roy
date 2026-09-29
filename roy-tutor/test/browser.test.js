// The real page in a real browser (Chromium via Playwright): press
// "Listen & Learn" once, then touch nothing. The browser plays each step's
// audio from the server (a real <audio> element; its 'ended' event drives the
// player). Word 1 must finish, Word 2 must start by itself, finish, and Word 3
// must start by itself, with the page's progress line following. If the page
// waited for a Next click, the waits below time out and the test fails.
// Skipped when Playwright or Chromium is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { startListenQwen, startTutorServer } from './helpers.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

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
  // Talk to the local server directly, never through an outbound proxy.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(https?|all|no)_proxy$/i.test(k)));
  try {
    return await pw.chromium.launch({ env, args: ['--autoplay-policy=no-user-gesture-required', '--no-proxy-server'] });
  } catch {
    return null;
  }
}

const browser = await launch();

test('browser: Listen & Learn plays Word 1 → Word 2 → Word 3 with no clicks after the first', { skip: !browser && 'Playwright/Chromium not installed' }, async () => {
  const q = await startListenQwen();
  const s = await startTutorServer(q.port);
  const page = await browser.newPage();
  try {
    const clicks = [];
    await page.exposeFunction('noteClick', (id) => clicks.push(id));
    await page.addInitScript(() => {
      window.seenStates = [];
      document.addEventListener('click', (e) => window.noteClick(e.target.closest('button')?.id ?? ''), true);
      const watch = () => {
        const el = document.getElementById('listen-state');
        if (!el) return setTimeout(watch, 20);
        const note = () => { if (window.seenStates.at(-1) !== el.textContent) window.seenStates.push(el.textContent); };
        new MutationObserver(note).observe(el, { childList: true, characterData: true, subtree: true });
      };
      watch();
    });
    await page.goto(s.url);
    await page.waitForFunction((v) => document.getElementById('version').textContent === `v${v}`, pkg.version, { timeout: 10000 });
    assert.equal(await page.isHidden('#notice') || !/update|git pull/i.test(await page.textContent('#notice')), true, 'no version-mismatch warning');
    await page.waitForFunction(() => /Word 1 of/.test(document.getElementById('progress').textContent));

    await page.click('#mode-listen'); // the only click
    await page.waitForFunction(() => /^Playing Word 1 /.test(document.getElementById('listen-state').textContent), null, { timeout: 15000 });
    await page.waitForFunction(() => /^Playing Word 2 /.test(document.getElementById('listen-state').textContent), null, { timeout: 30000 });
    await page.waitForFunction(() => /Word 2 of/.test(document.getElementById('progress').textContent), null, { timeout: 5000 });
    await page.waitForFunction(() => /^Playing Word 3 /.test(document.getElementById('listen-state').textContent), null, { timeout: 30000 });
    await page.waitForFunction(() => /Word 3 of/.test(document.getElementById('progress').textContent), null, { timeout: 5000 });
    await page.click('#listen-pause');

    const seen = await page.evaluate(() => window.seenStates);
    assert.ok(seen.includes('Completed Word 1. Starting Word 2…'), seen.join(' | '));
    assert.ok(seen.includes('Completed Word 2. Starting Word 3…'), seen.join(' | '));
    assert.ok(!seen.some((t) => /Finished this word|→ Next for the next word/.test(t)), 'the old "press Next" message never shows');
    assert.deepEqual(clicks, ['mode-listen', 'listen-pause'], 'no Next (or other) click was needed');
    const status = await (await fetch(`${s.url}/api/status`)).json();
    assert.equal(status.position, 3, 'the shared place (Interactive Practice too) is Word 3');
    assert.ok(q.seen.tts > 0, 'the audio came from the Qwen TTS stand-in');
  } finally {
    await page.close();
    await s.stop();
    await q.close();
  }
});

test.after(() => browser?.close());

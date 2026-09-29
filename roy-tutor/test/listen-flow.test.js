// Continuous Listen & Learn through the REAL server: the real ListenController
// (the one the page uses) loads lessons from GET /api/listen, "plays" each
// step's real Qwen audio (downloaded from the server; an 'ended' event follows),
// and reports finished lessons with POST /api/listen/complete.
//
// Proves: Word 1 audio ended → Word 2 starts by itself → Word 2 audio ended →
// Word 3 starts by itself, with the shared curriculum position moving 1 → 2 → 3.
// Nothing ever calls next() in that part: if the player waited for a Next click,
// the wait below times out and the test fails.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ListenController, listenStatusText } from '../public/voice-core.js';
import { startListenQwen, startTutorServer } from './helpers.js';

const until = async (check, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// The page's audio, simulated like public/app.js playListenStep: download the
// step's audio from the server, then play it ('ended' follows on the next
// tick). stopAudio() (Pause, Repeat, Next) cancels the clip in progress, and a
// clip cancelled while it was still downloading is dropped, not played.
function simulatedAudio(url, log) {
  let stopCurrent = null;
  let run = 0;
  return {
    async playStep(step) {
      const mine = run;
      const r = await fetch(`${url}/api/voice/speech/${step.audio}`);
      if (!r.ok) throw Object.assign(new Error('audio failed'), { code: 'tts_failed' });
      const bytes = Buffer.from(await r.arrayBuffer());
      assert.equal(bytes.toString('ascii', 0, 4), 'RIFF', 'real WAV audio from the server');
      if (mine !== run) return; // cancelled while downloading
      log.push(step);
      await new Promise((resolve) => {
        const timer = setTimeout(() => { stopCurrent = null; resolve(); }, 5); // 'ended'
        stopCurrent = () => { clearTimeout(timer); resolve(); };
      });
    },
    stopAudio() { run += 1; stopCurrent?.(); stopCurrent = null; },
  };
}

function player(url, { gapMs = 20 } = {}) {
  const events = [];
  const statuses = [];
  const stepLog = [];
  const audio = simulatedAudio(url, stepLog);
  const p = new ListenController({
    ...audio,
    gapMs,
    loadLesson: async (target) => {
      const r = await fetch(`${url}/api/listen${target ? `?position=${target.position}${target.review ? '&review=1' : ''}` : ''}`);
      if (!r.ok) throw new Error(`load failed ${r.status}`);
      const lesson = await r.json();
      events.push(`loaded ${lesson.position}`);
      return lesson;
    },
    onComplete: async (lesson) => {
      const r = await fetch(`${url}/api/listen/complete`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ position: lesson.position, review: Boolean(lesson.review) }) });
      const body = await r.json();
      events.push(`completed ${lesson.position} -> place ${body.currentPosition}`);
    },
    onChange: (view) => {
      const line = listenStatusText(view);
      if (statuses.at(-1) !== line) statuses.push(line);
      if (view.state === 'playing' && view.index === 0 && events.at(-1) !== `started ${view.position}`) events.push(`started ${view.position}`);
    },
  });
  return { p, events, statuses, stepLog };
}

const place = async (url) => (await (await fetch(`${url}/api/status`)).json()).position;

test('continuous: Word 1 ends → Word 2 starts by itself → Word 2 ends → Word 3 starts, and the shared position follows', async () => {
  const q = await startListenQwen();
  const s = await startTutorServer(q.port);
  try {
    const { p, events, statuses } = player(s.url);
    p.open(undefined); // what the Listen & Learn button does; no other call below
    await until(() => p.view.position === 3 && p.state === 'playing', 'Word 3 playing without a Next click');
    p.pause();
    assert.deepEqual(events.filter((e) => /^(started|completed)/.test(e)), [
      'started 1',
      'completed 1 -> place 2',
      'started 2',
      'completed 2 -> place 3',
      'started 3',
    ], 'each word starts only after the previous one finished and was recorded');
    assert.ok(statuses.includes('Completed Word 1. Starting Word 2…'), statuses.join(' | '));
    assert.ok(statuses.includes('Completed Word 2. Starting Word 3…'));
    assert.ok(!statuses.some((t) => /Finished this word|→ Next for the next word/.test(t)), 'no "click Next" message');
    assert.equal(await place(s.url), 3, 'Interactive Practice is at word 3 too');
    assert.equal(q.seen.teacherTurns, 0);
  } finally {
    await s.stop();
    await q.close();
  }
});

test('Pause keeps the current word (no advance), Play resumes it, then it continues by itself', async () => {
  const q = await startListenQwen();
  const s = await startTutorServer(q.port);
  try {
    const { p, events, stepLog } = player(s.url);
    p.open(undefined);
    await until(() => p.state === 'playing' && p.view.index >= 2, 'word 1 part way');
    p.pause();
    const stepAtPause = p.view.index;
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(p.state, 'paused');
    assert.equal(p.view.position, 1);
    assert.equal(await place(s.url), 1, 'pausing does not advance');
    assert.ok(!events.some((e) => e.startsWith('completed')));
    const before = stepLog.length;
    p.play();
    await until(() => stepLog.length > before, 'resume');
    assert.equal(stepLog[before], p.lesson.steps[stepAtPause], 'resumes at the interrupted step of word 1');
    await until(() => p.view.position === 2 && p.state === 'playing', 'then Word 2 by itself');
    p.pause();
    assert.equal(await place(s.url), 2);
  } finally {
    await s.stop();
    await q.close();
  }
});

test('Next skips intentionally (no advance of the place); Repeat replays the whole current lesson', async () => {
  const q = await startListenQwen();
  const s = await startTutorServer(q.port);
  try {
    const { p, events, stepLog } = player(s.url, { gapMs: 60000 });
    p.open(undefined);
    await until(() => p.state === 'playing' && p.view.index >= 1, 'word 1 playing');
    p.next(); // skip word 1
    await until(() => p.view.position === 2 && p.state === 'playing', 'Word 2 after Next');
    assert.equal(await place(s.url), 1, 'a skipped word is not completed: the place stays at word 1');
    assert.ok(!events.some((e) => e.startsWith('completed 1')));

    await until(() => p.view.index >= 3, 'word 2 part way');
    const before = stepLog.length;
    p.repeat();
    await until(() => stepLog.length > before, 'repeat');
    assert.equal(p.view.position, 2);
    assert.equal(stepLog[before], p.lesson.steps[0], 'Repeat starts the current lesson from its first step');
    await until(() => p.state === 'gap', 'word 2 finished (long gap so it stops here)');
    assert.ok(events.includes('completed 2 -> place 1'), 'word 2 was heard in full, but it is not the current word: logged only');
    p.pause();
  } finally {
    await s.stop();
    await q.close();
  }
});

test('the page and the server report the same version (a stale page is detected)', async () => {
  const { CLIENT_VERSION } = await import('../public/voice-core.js');
  const { readFileSync } = await import('node:fs');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(CLIENT_VERSION, pkg.version);
  const q = await startListenQwen();
  const s = await startTutorServer(q.port);
  try {
    assert.equal((await (await fetch(`${s.url}/api/status`)).json()).version, pkg.version);
  } finally {
    await s.stop();
    await q.close();
  }
});

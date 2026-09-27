import { normZh, tonelessPinyin } from './match.js';

// Two separate things, kept separate on purpose:
//
// A. WORD RECOGNITION (available now). The browser's speech recogniser returns
//    text, not audio. checkWordRecognition() reports whether that text contains
//    the expected Mandarin characters, and which characters it did not contain.
//    This says what the recogniser understood. It is not a pronunciation score
//    and says nothing reliable about tones.
//
// B. PRONUNCIATION ASSESSMENT (not available yet). Judging tones and sounds
//    needs the audio itself. assessPronunciation() is the hook for that: when an
//    audio-analysis service is added, the browser will send the recording and
//    this function will return per-syllable results. Until then it returns null,
//    and the teacher is told that no pronunciation assessment exists.

const SPEECH = 'voice';

// Characters of `expected` found in order in `heard` (longest common subsequence).
function alignChars(expected, heard) {
  const n = expected.length;
  const m = heard.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] = expected[i - 1] === heard[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const matched = new Array(n).fill(false);
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (expected[i - 1] === heard[j - 1]) { matched[i - 1] = true; i--; j--; }
    else if (dp[i - 1][j] >= dp[i][j - 1]) i--;
    else j--;
  }
  return matched;
}

// Pinyin syllable for each character, when the source pinyin lines up one
// syllable per character; otherwise null for every character.
export function syllablesFor(entry) {
  const chars = [...normZh(entry.mandarin)];
  const syllables = entry.pinyin.trim().split(/\s+/);
  return chars.map((_, i) => (syllables.length === chars.length ? syllables[i] : null));
}

/**
 * @param entry  curriculum entry
 * @param heard  { text, alternatives?: string[], confidence?: number, source?: 'voice'|'text' }
 * @returns {{ verdict: 'correct'|'close'|'partial'|'incorrect', passed: boolean, heard: string,
 *             typed: boolean, missing: {char: string, syllable: string|null}[], via: string|null,
 *             lowConfidence: boolean }}
 */
export function checkWordRecognition(entry, heard) {
  const text = String(heard.text ?? '');
  const typed = heard.source !== SPEECH;
  const candidates = [text, ...(heard.alternatives ?? [])].filter(Boolean);
  const expected = [...normZh(entry.mandarin)];
  const syllables = syllablesFor(entry);
  const base = { heard: text, typed, missing: [], via: null, lowConfidence: false };

  const hasTerm = (c) => normZh(c).includes(expected.join(''));
  const pinyinMatch = (c) => {
    const py = tonelessPinyin(entry.pinyin);
    return py.length > 1 && tonelessPinyin(c).includes(py);
  };

  if (hasTerm(text)) {
    const lowConfidence = !typed && typeof heard.confidence === 'number' && heard.confidence > 0 && heard.confidence < 0.5;
    return { ...base, verdict: 'correct', passed: true, lowConfidence };
  }
  const alt = candidates.slice(1).find(hasTerm);
  if (alt) return { ...base, verdict: 'close', passed: true, via: alt };
  const py = candidates.find(pinyinMatch);
  if (py) return { ...base, verdict: 'close', passed: true, via: py };

  // Best partial match across all the recogniser's guesses.
  let best = null;
  for (const c of candidates) {
    const matched = alignChars(expected, [...normZh(c)]);
    const count = matched.filter(Boolean).length;
    if (!best || count > best.count) best = { count, matched, candidate: c };
  }
  const missing = expected
    .map((char, i) => ({ char, syllable: syllables[i], ok: best?.matched[i] }))
    .filter((x) => !x.ok)
    .map(({ char, syllable }) => ({ char, syllable }));
  const count = best?.count ?? 0;
  const verdict = count > 0 && count >= Math.ceil(expected.length / 2) ? 'partial' : 'incorrect';
  return { ...base, verdict, passed: false, missing, via: best?.candidate ?? null };
}

const TONE_MARKS = {
  1: /[āēīōūǖĀĒĪŌŪǕ]/, 2: /[áéíóúǘÁÉÍÓÚǗ]/, 3: /[ǎěǐǒǔǚǍĚǏǑǓǙ]/, 4: /[àèìòùǜÀÈÌÒÙǛ]/,
};

// Syllables of the source pinyin with their tone numbers (5 = neutral), for teaching.
export function syllablesWithTones(entry) {
  return String(entry.pinyin || '')
    .split(/[\s/,()（）-]+/)
    .filter((syl) => /\p{L}/u.test(syl))
    .map((syl) => ({ syllable: syl, tone: Number(Object.keys(TONE_MARKS).find((t) => TONE_MARKS[t].test(syl)) ?? 5) }));
}

// Hook for real pronunciation scoring from audio (see B above). Not implemented.
export async function assessPronunciation(/* { entry, audio } */) {
  return null;
}

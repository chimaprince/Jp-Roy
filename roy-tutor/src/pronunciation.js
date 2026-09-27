import { normZh, tonelessPinyin, normEn, englishForms } from './match.js';

// Pronunciation check, first version.
//
// The browser's speech recogniser gives us text, not audio, so this cannot
// score tones or sounds directly. What it can do:
//   - check whether the recogniser heard the expected characters (its top
//     result, then its other guesses),
//   - find which characters it did and did not hear, so the tutor can say
//     which syllable needs work.
// When the recogniser hears a different character with a similar sound, that
// usually points to a tone or sound slip; the AI tutor (if enabled) explains
// those substitutions, and says it is inferring from text.

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
export function checkPronunciation(entry, heard) {
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

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'which', 'what', 'means', 'mean', 'meaning', 'its', 'are', 'was', 'used', 'when', 'your', 'you', 'it\'s', 'thing', 'kind']);

function contentWords(s) {
  return normEn(s).trim().split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}

// Built-in meaning check, used when the AI tutor is off or fails.
// Accepts the English term (or one of its forms), or an answer that covers
// most of the key words of the source meaning.
export function checkMeaningLocally(entry, answer) {
  const heard = normEn(answer);
  if (englishForms(entry.english).some((f) => heard.includes(f))) return { correct: true, reason: 'term' };
  if (entry.meaning) {
    const key = [...new Set(contentWords(entry.meaning))];
    const said = new Set(contentWords(answer));
    const hits = key.filter((w) => said.has(w) || [...said].some((s) => s.length > 4 && (w.startsWith(s) || s.startsWith(w))));
    if (key.length && hits.length / key.length >= 0.5) return { correct: true, reason: 'meaning' };
  }
  return { correct: false, reason: null };
}

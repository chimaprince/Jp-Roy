// ASR-aware evaluation of a spoken Mandarin answer.
//
// The speech recogniser (Qwen ASR) returns characters, and Chinese has many
// characters with the same sound. When Roy says 硬膜外 (yìng mó wài) correctly,
// the recogniser may write 硬磨外: 磨 is also read mó. The transcript is
// evidence, not ground truth. This module compares what was transcribed with
// the current curriculum term, sound by sound, and says how confident we can
// be:
//
//   high_confidence_correct   the recogniser wrote exactly the expected characters
//   likely_correct_asr_character_mismatch
//                             every syllable sounds the same (same syllable and
//                             tone); only the characters differ. Evidence of a
//                             recogniser character error, NOT of a mispronunciation.
//   uncertain                 close but not the same: a tone differs, a
//                             commonly confused sound (zh/z, n/l, in/ing...), one
//                             syllable of a longer term, or pinyin letters only
//   clearly_incorrect         the expected sounds are not there
//
// It never upgrades a wrong sound to correct just because the expected answer
// is known: only same-sound characters count as a likely character error.
// It says nothing reliable about tones beyond what the recogniser's choice of
// characters implies.
import { pinyin, polyphonic } from 'pinyin-pro';
import { normZh, tonelessPinyin } from './match.js';

export const LEVELS = ['high_confidence_correct', 'likely_correct_asr_character_mismatch', 'uncertain', 'clearly_incorrect'];

const HAN = /\p{Script=Han}/u;

// "yìng" → "ying4"; "lǜ" → "lv4"; "de" → "de5".
export function numberedSyllable(syl) {
  const s = String(syl).normalize('NFD').toLowerCase();
  let tone = 5;
  const marks = { '̄': 1, '́': 2, '̌': 3, '̀': 4 };
  for (const [mark, t] of Object.entries(marks)) if (s.includes(mark)) tone = t;
  const base = s.replace(/[̀-ͯ]/g, (m) => (m === '̈' ? '̈' : '')).normalize('NFC').replace(/ü/g, 'v').replace(/ü/g, 'v').replace(/[^a-z]/g, '');
  const digit = base.match(/[1-5]$/);
  return digit ? base : `${base}${tone}`;
}

function fromLibrary(syl) {
  // pinyin-pro: "lü4" / "mo2" / "de0" (neutral).
  const s = String(syl).toLowerCase().replace(/ü/g, 'v');
  return s.replace(/0$/, '5');
}

const split = (numbered) => ({ base: numbered.replace(/[1-5]$/, ''), tone: Number(numbered.slice(-1)) || 5 });

// Commonly confused sounds (regional accents and recognisers mix these up).
export function fuzzy(base) {
  return base
    .replace(/^zh/, 'z').replace(/^ch/, 'c').replace(/^sh/, 's')
    .replace(/^l/, 'n').replace(/^r/, 'n')
    .replace(/ing$/, 'in').replace(/eng$/, 'en').replace(/ang$/, 'an');
}

// Expected syllables for the term: the curriculum pinyin when it lines up one
// syllable per character, otherwise the dictionary reading of the term.
export function expectedSyllables(entry) {
  const chars = [...normZh(entry.mandarin)].filter((c) => HAN.test(c));
  const src = String(entry.pinyin || '').split(/[\s/,()（）-]+/).filter((x) => /\p{L}/u.test(x));
  if (src.length === chars.length && chars.length) return { chars, syllables: src.map(numberedSyllable), from: 'curriculum pinyin' };
  const lib = pinyin(chars.join(''), { toneType: 'num', type: 'array' }).map(fromLibrary);
  return { chars, syllables: lib, from: 'dictionary reading of the term' };
}

function readings(char) {
  const r = polyphonic(char, { toneType: 'num', type: 'array' })[0] ?? [];
  return [...new Set(r.map(fromLibrary))];
}

// How one heard character compares with one expected character.
function compare(expChar, expSyl, heardChar) {
  if (heardChar === expChar) return { match: 'same_character', score: 3 };
  const heardReadings = readings(heardChar);
  const e = split(expSyl);
  if (heardReadings.includes(expSyl)) return { match: 'same_sound', score: 2.6, heardReadings };
  const bases = heardReadings.map((r) => split(r).base);
  if (bases.includes(e.base)) return { match: 'same_syllable_different_tone', score: 1.6, heardReadings };
  if (bases.some((b) => fuzzy(b) === fuzzy(e.base))) return { match: 'similar_sound', score: 1.2, heardReadings };
  return { match: 'different', score: -1, heardReadings };
}

// Best placement of the expected term inside the transcript (the transcript may
// have extra words): semi-global alignment, every expected character aligned
// to one heard character or to nothing.
function align(chars, syllables, heard) {
  const n = chars.length;
  const m = heard.length;
  const GAP = -1.5;
  const S = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  const B = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  const C = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(null));
  for (let i = 1; i <= n; i++) { S[i][0] = S[i - 1][0] + GAP; B[i][0] = 'up'; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const c = compare(chars[i - 1], syllables[i - 1], heard[j - 1]);
      const diag = S[i - 1][j - 1] + c.score;
      const up = S[i - 1][j] + GAP; // expected character missing
      const left = S[i][j - 1] + (i === n ? 0 : GAP); // extra heard character inside the term
      const best = Math.max(diag, up, left);
      S[i][j] = best;
      B[i][j] = best === diag ? 'diag' : best === up ? 'up' : 'left';
      C[i][j] = c;
    }
  }
  // Free leading/trailing transcript: start anywhere (row 0 is 0), end anywhere.
  let j = 0;
  for (let k = 1; k <= m; k++) if (S[n][k] > S[n][j]) j = k;
  const out = new Array(n).fill(null);
  for (let i = n; i > 0;) {
    const b = j > 0 ? B[i][j] : 'up';
    if (b === 'diag') { out[i - 1] = { heard: heard[j - 1], ...C[i][j] }; i--; j--; }
    else if (b === 'up') { out[i - 1] = { heard: null, match: 'missing', score: GAP }; i--; }
    else j--;
  }
  return out;
}

/**
 * Evaluate a transcript against the current term.
 * @returns {{ level, expected, expected_pinyin, heard, characters, english_term_mentioned, explanation }}
 */
export function evaluateSpokenTerm(entry, transcript) {
  const text = String(transcript ?? '');
  const heard = [...text].filter((c) => HAN.test(c));
  const { chars, syllables, from } = expectedSyllables(entry);
  const english = String(entry.english || '').toLowerCase();
  const base = {
    expected: entry.mandarin,
    expected_pinyin: entry.pinyin || null,
    expected_syllables: syllables,
    syllables_from: from,
    heard: text,
    english_term_mentioned: Boolean(english) && text.toLowerCase().includes(english),
  };
  if (!chars.length) return { ...base, level: 'uncertain', characters: [], explanation: 'The term has no Chinese characters to compare.' };

  if (!heard.length) {
    const py = tonelessPinyin(entry.pinyin || syllables.join(''));
    if (py.length > 1 && tonelessPinyin(text).includes(py.replace(/[1-5]/g, ''))) {
      return { ...base, level: 'uncertain', characters: [], explanation: 'The recogniser wrote pinyin letters, not characters: the sounds may be right, but tones cannot be read from it.' };
    }
    return { ...base, level: 'clearly_incorrect', characters: [], explanation: 'No Mandarin was recognised in the answer.' };
  }

  const aligned = align(chars, syllables, heard);
  const characters = chars.map((c, i) => ({
    expected: c,
    expected_syllable: syllables[i],
    heard: aligned[i]?.heard ?? null,
    heard_readings: aligned[i]?.heardReadings ?? (aligned[i]?.heard ? [syllables[i]] : []),
    match: aligned[i]?.match ?? 'missing',
  }));
  const kinds = characters.map((c) => c.match);
  const count = (k) => kinds.filter((x) => x === k).length;
  const bad = count('different') + count('missing');
  let level;
  if (kinds.every((k) => k === 'same_character')) level = 'high_confidence_correct';
  else if (kinds.every((k) => k === 'same_character' || k === 'same_sound')) level = 'likely_correct_asr_character_mismatch';
  else if (bad === 0) level = 'uncertain';
  // One syllable of a longer term recognised as some other character: could be
  // the recogniser or Roy, so neither right nor wrong. A missing syllable is not.
  else if (count('missing') === 0 && count('different') === 1 && chars.length >= 3 && kinds.filter((k) => k === 'same_character' || k === 'same_sound').length === chars.length - 1) level = 'uncertain';
  else level = 'clearly_incorrect';

  const swapped = characters.filter((c) => c.match === 'same_sound').map((c) => `${c.heard} for ${c.expected} (both ${c.expected_syllable})`);
  const explanation = {
    high_confidence_correct: 'The recogniser wrote exactly the expected characters.',
    likely_correct_asr_character_mismatch: `Every syllable matches the expected sounds; the recogniser only chose a different character with the same sound: ${swapped.join(', ')}. This is a recogniser character error, not evidence of a mispronunciation.`,
    uncertain: 'Close to the expected term but not the same sounds (a tone, a commonly confused sound, or one syllable differs). The evidence is not strong enough to call it right or wrong.',
    clearly_incorrect: 'The expected sounds were not recognised.',
  }[level];
  return { ...base, level, characters, explanation };
}

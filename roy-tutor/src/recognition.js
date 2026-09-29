// Pinyin helpers for teaching, and the hook for real pronunciation scoring.
//
// Judging answers from the speech recogniser's transcript is done in
// evaluation.js (sound by sound, because the recogniser often writes a
// different character with the same sound). Tones and accent cannot be judged
// from a transcript at all: that needs the audio itself, which is what
// assessPronunciation() is for. Until an audio-analysis service is added it
// returns null, and the teacher is told no pronunciation assessment exists.

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

// Hook for real pronunciation scoring from audio (see above). Not implemented.
export async function assessPronunciation(/* { entry, audio } */) {
  return null;
}

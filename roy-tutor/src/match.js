// Answer checking. These helpers only normalise copies for comparison;
// the curriculum values themselves are never changed.

export function normZh(s) {
  return String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

export function tonelessPinyin(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ü/g, 'v')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function normEn(s) {
  return ` ${String(s ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()} `;
}

// Did Roy say the Mandarin term? Accepts the characters, or the pinyin when
// speech recognition returns Latin letters.
export function saidMandarin(transcript, entry) {
  const zh = normZh(entry.mandarin);
  if (zh && normZh(transcript).includes(zh)) return true;
  const py = tonelessPinyin(entry.pinyin);
  return py.length > 1 && tonelessPinyin(transcript).includes(py);
}

// English forms Roy may give: the whole term, the term without a bracketed
// part, and each "/" or ";" alternative.
export function englishForms(english) {
  const forms = new Set([english]);
  const noBrackets = english.replace(/\([^)]*\)/g, ' ');
  forms.add(noBrackets);
  for (const part of noBrackets.split(/[/;]| or /)) forms.add(part);
  return [...forms].map(normEn).filter((f) => f.trim().length > 1);
}

export function saidEnglish(transcript, entry) {
  const heard = normEn(transcript);
  return englishForms(entry.english).some((f) => heard.includes(f));
}

// Hint: first character plus its pinyin syllable, when the source pinyin is
// space-separated; otherwise just the first character.
export function hintFor(entry) {
  const firstChar = [...entry.mandarin][0] ?? '';
  const syllables = entry.pinyin.trim().split(/\s+/);
  const charCount = [...normZh(entry.mandarin)].length;
  const firstSyllable = syllables.length === charCount ? syllables[0] : null;
  return { firstChar, firstSyllable };
}

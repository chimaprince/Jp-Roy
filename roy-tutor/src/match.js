// Normalised copies for comparison only; curriculum values are never changed.

export function normZh(s) {
  return String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '');
}

export function tonelessPinyin(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ü/g, 'v')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

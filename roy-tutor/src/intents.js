// Finds a curriculum entry for a jump request ("word 12", "gangrene", "坏疽").
// Only entries in the course can be found, so a jump never brings in outside
// vocabulary. Understanding what Roy asked for is the AI teacher's job; this
// only resolves the target it names.
export function findEntry(entries, target) {
  const t = String(target).trim().toLowerCase().replace(/[.!?]+$/, '');
  const num = t.match(/^(?:word |entry |number |#)?(\d+)$/);
  if (num) return entries.find((e) => e.position === Number(num[1])) ?? null;
  const zh = t.replace(/\s/g, '');
  return (
    entries.find((e) => e.english.toLowerCase() === t) ||
    entries.find((e) => e.mandarin.replace(/\s/g, '') === zh) ||
    entries.find((e) => e.pinyin.toLowerCase() === t) ||
    entries.find((e) => e.english.toLowerCase().includes(t) && t.length > 2) ||
    null
  );
}

// Spoken commands Roy can use at any point. Chinese forms are included because
// the microphone may be listening in Mandarin when he says them.

export const ROLES = ['Doctor', 'Patient', 'Interpreter', 'Nurse', 'Hospital staff'];

const PATTERNS = [
  ['end', /^(?:(?:ok(?:ay)?,? )?(?:stop|let'?s stop|end (?:the )?session|that'?s (?:all|enough)(?: for today)?|good ?bye|bye|finish(?: for today)?)|结束|再见)[.!。！]?$/i],
  ['backToCurriculum', /\b(?:back to (?:the )?(?:curriculum|lesson|course|where (?:i|we) (?:was|were))|return to (?:the )?(?:curriculum|lesson))\b/i],
  ['continue', /^(?:ok(?:ay)?,? )?(?:let'?s (?:continue|keep going|go on)|continue|keep going|resume|继续)[.!。！]?$/i],
  ['dontUnderstand', /\b(?:i )?(?:don'?t|do not) understand\b|\bwhat does (?:that|it) mean\b|\bexplain (?:that|it) again\b|我不懂|我不明白|听不懂|不明白/i],
  ['forgot', /\bi (?:forgot|forget|can'?t remember|don'?t remember)\b|^(?:i )?forgot\b|我忘了|忘了|想不起来/i],
  ['repeat', /\b(?:repeat|say (?:it|that) again|again please|one more time)\b|再说一遍|再说一次/i],
];

const JUMP = /\b(?:jump to|go to|skip to|teach me|take me to|let'?s (?:study|do|practi[cs]e|learn)|show me)\s+(?:the (?:word|term) (?:for )?|the word |word |entry |number |term )?["']?(.+?)["']?\s*[.!?]?$/i;
const ROLE = /\b(?:role[- ]?play|you(?:'re| are) the|i(?:'ll| will)? (?:be|play)|play(?: the)?|as (?:the|a|an))\s*(?:the |a |an )?(doctor|patient|interpreter|nurse|hospital staff|staff|receptionist)\b/i;

export function detectIntent(text) {
  const t = String(text ?? '').trim();
  if (!t) return { type: 'empty' };
  for (const [type, re] of PATTERNS) if (re.test(t)) return { type };
  const role = t.match(ROLE);
  if (role) {
    const word = role[1].toLowerCase();
    const found = word === 'staff' || word === 'receptionist' ? 'Hospital staff' : ROLES.find((r) => r.toLowerCase() === word);
    // "You are the doctor" names the tutor's part; Roy then interprets.
    if (/\byou(?:'re| are) the\b/i.test(t)) {
      return { type: 'role', role: found === 'Interpreter' ? 'Doctor' : 'Interpreter' };
    }
    return { type: 'role', role: found };
  }
  if (/^role[- ]?play\b/i.test(t)) return { type: 'role', role: null };
  const jump = t.match(JUMP);
  if (jump) return { type: 'jump', target: jump[1] };
  return { type: 'answer', text: t };
}

// Finds a curriculum entry for a jump request. Only entries in the course can
// be found, so a jump never brings in outside vocabulary.
export function findEntry(entries, target) {
  const t = String(target).trim().toLowerCase().replace(/[.!?]+$/, '');
  const num = t.match(/^(?:word |entry |number )?(\d+)$/);
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

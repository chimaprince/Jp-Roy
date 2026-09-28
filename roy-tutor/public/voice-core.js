// Pure helpers for the voice page. No DOM, no network: the page (app.js) uses
// them, and the tests run them in Node.

// Recognition language for the browser. The server decides which language the
// next answer should be in; Roy can override it for one turn. Chrome's
// recogniser lists Mandarin as cmn-Hans-CN; other browsers take zh-CN.
export function recognitionLang(lang, { isChrome = false } = {}) {
  return lang === 'zh-CN' && isChrome ? 'cmn-Hans-CN' : lang;
}

export function isChromeBrowser(nav) {
  if (!nav) return false;
  if (nav.userAgentData?.brands?.some((b) => b.brand === 'Google Chrome')) return true;
  return /Chrome\//.test(nav.userAgent ?? '') && !/Edg\//.test(nav.userAgent ?? '');
}

export const LANGUAGE_LABEL = { 'zh-CN': 'Mandarin', 'en-US': 'English' };

export function otherLanguage(lang) {
  return lang === 'zh-CN' ? 'en-US' : 'zh-CN';
}

// What the lesson is doing now, in plain words.
const EXERCISE_TEXT = {
  pronounce: 'Say the Mandarin term',
  meaning: 'Explain the meaning in English',
  sentence: 'Make a Mandarin sentence with the term',
  roleplay: 'Role-play',
  review: 'Review: say the Mandarin',
};

export function lessonStateText(view) {
  if (!view) return '';
  if (view.stage === 'done') return 'All words complete';
  const parts = [];
  if (view.card?.position) parts.push(`Word ${view.card.position}`);
  const what = EXERCISE_TEXT[view.exercise];
  if (what) parts.push(view.exercise === 'roleplay' && view.role ? `${what} (you are the ${view.role.toLowerCase()})` : what);
  if (view.jump) parts.push('side trip, your place is saved');
  return parts.join(' · ');
}

// Speech playback: split each line into runs by script, so Chinese characters
// are read by a Chinese voice and Latin text by an English voice, whatever
// language the line was labelled with.
const HAN_RUN = /([\p{Script=Han}\u3000-\u303f\uff00-\uffef]+(?:[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef]*[\p{Script=Han}\u3000-\u303f\uff00-\uffef])?)/u;
const HAS_HAN = /\p{Script=Han}/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function speechParts(segment) {
  const text = String(segment?.text ?? '');
  const rate = segment?.rate;
  const out = [];
  for (const piece of text.split(HAN_RUN)) {
    if (!piece || !piece.trim()) continue;
    const lang = HAS_HAN.test(piece) ? 'zh' : 'en';
    // Punctuation-only fragments are not worth a separate utterance.
    if (lang === 'en' && !HAS_LETTER_OR_DIGIT.test(piece)) continue;
    const prev = out.at(-1);
    if (prev && prev.lang === lang) prev.text += piece;
    else out.push({ lang, text: piece.trim(), ...(rate ? { rate } : {}) });
  }
  return out.map((p) => ({ ...p, text: p.text.trim() }));
}

// Human-readable messages for everything that can go wrong.
export function friendlyError(err) {
  const code = err?.code;
  if (code === 'ai_not_configured') return 'The AI teacher is not set up on the server (DASHSCOPE_API_KEY is missing).';
  if (code === 'ai_request_failed') return "The AI teacher (Qwen) didn't answer. Check the server's internet connection and try again.";
  if (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed/i.test(err?.message ?? '')) {
    return "Can't reach the tutor server. Is it still running? Check the terminal, then try again.";
  }
  if (code === 'server_error' || err?.status >= 500) return 'The tutor server had a problem. Try again; if it keeps happening, check the terminal.';
  return err?.message || 'Something went wrong. Try again.';
}

export const RECOGNITION_ERRORS = {
  'not-allowed': 'Microphone access is blocked. Click the camera/microphone icon in the address bar, allow the microphone, then tap START TALKING. You can also type below.',
  'service-not-allowed': 'This browser does not allow speech recognition here. Use Chrome or Edge on http://localhost:3000, or type below.',
  'audio-capture': 'No microphone was found. Connect or enable one and tap START TALKING, or type below.',
  network: "The browser's speech recognition service can't be reached (it needs the internet). Type below for now.",
  'language-not-supported': "This browser can't recognise that language. Tap the language button to switch, or type below.",
};

// Pure helpers for the voice page. No DOM, no network: the page (app.js) uses
// them, and the tests run them in Node.

// Recognition language for the browser: zh-CN for Mandarin, en-US for
// English. The server decides which one the next answer should be in; Roy can
// override it for one turn. (An earlier version sent Chrome "cmn-Hans-CN";
// zh-CN is the tag Chrome documents and accepts, so it is used everywhere.)
export const RECOGNITION_LANGS = { 'zh-CN': 'zh-CN', 'en-US': 'en-US' };

export function recognitionLang(lang) {
  return RECOGNITION_LANGS[lang] ?? 'en-US';
}

// Kept for the page's own use (and tests); no longer changes the language tag.
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
  network: "The browser's speech recognition service can't be reached (Chrome sends audio to Google to recognise it, so it needs the internet). Type below for now.",
  'language-not-supported': "This browser can't recognise that language. Tap the language button to switch, or type below.",
  'bad-grammar': 'Speech recognition was set up wrongly (bad-grammar). Reload the page and try again.',
  'start-failed': "The microphone could not start (it may be in use by another tab or app). Close other tabs using the microphone and tap START TALKING.",
  'start-timeout': "Speech recognition did not start. Reload the page; if it keeps happening, restart Chrome.",
  'no-result': 'Sound was heard but no words were recognised. Speak a little louder and closer to the microphone, check the language shown above, then tap START TALKING.',
  timeout: 'Listening took too long without a result, so it was stopped. Tap START TALKING to try again.',
};

// ---------- speech recognition controller ----------
//
// One recogniser per listening turn. Every Web Speech event is reported, and
// the turn ends in exactly one outcome:
//   onFinal({ text, alternatives, confidence, lang })  a non-empty transcript
//   onEmpty(reason)   'no-speech' (nothing heard) or 'no-result' (sound, no words)
//   onError(code)     a recognition error (not-allowed, audio-capture, network, ...)
// Events from an older recogniser (after stop() or a new listen()) are ignored,
// so switching language never leaves a stale instance feeding the page.
// Watchdogs make sure LISTENING never hangs silently.

export const EVENTS = ['start', 'audiostart', 'soundstart', 'speechstart', 'result', 'speechend', 'soundend', 'audioend', 'nomatch', 'error', 'end'];

export class VoiceInput {
  // The default timers are wrapped: browsers throw "Illegal invocation" when
  // setTimeout/clearTimeout are called as methods of another object.
  constructor(Recognition, { setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (id) => clearTimeout(id), log = () => {}, limits = {} } = {}) {
    this.Recognition = Recognition;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.log = log;
    this.limits = { startMs: 5000, silentMicMs: 7000, afterSpeechMs: 8000, totalMs: 30000, ...limits };
    this.turn = 0;
    this.active = null;
  }

  get available() { return Boolean(this.Recognition); }
  get listening() { return Boolean(this.active); }

  // Starts a listening turn. Any turn already running is stopped first.
  listen(lang, handlers = {}) {
    this.stop();
    if (!this.Recognition) { handlers.onError?.('unavailable'); return null; }
    const turn = ++this.turn;
    const rec = new this.Recognition();
    rec.lang = recognitionLang(lang);
    rec.continuous = false; // one answer per turn; the page starts the next turn
    rec.interimResults = true;
    rec.maxAlternatives = 5;
    const t = { turn, rec, lang: rec.lang, finalText: '', interim: '', alternatives: [], confidence: null, error: null, heardSound: false, heardSpeech: false, done: false, timers: {} };
    this.active = t;
    const live = () => this.active === t; // ignore events from stale recognisers
    const status = (kind, detail) => handlers.onStatus?.(kind, detail);
    const timer = (name, ms, fn) => { this.clearTimer(t.timers[name]); t.timers[name] = this.setTimer(() => live() && fn(), ms); };
    const clear = (name) => { this.clearTimer(t.timers[name]); delete t.timers[name]; };

    for (const name of EVENTS) {
      rec[`on${name}`] = (e) => {
        if (!live()) return;
        this.log(`[speech] ${name}${name === 'error' ? ` ${e?.error}${e?.message ? ` (${e.message})` : ''}` : ''}`);
        this.#handle(name, e, t, { status, timer, clear, handlers });
      };
    }

    timer('start', this.limits.startMs, () => this.#fail(t, 'start-timeout', handlers));
    timer('total', this.limits.totalMs, () => this.#settle(t, 'timeout', handlers));
    status('starting', { lang: rec.lang });
    try {
      rec.start();
    } catch (err) {
      this.log(`[speech] start() threw: ${err?.name} ${err?.message}`);
      this.#fail(t, 'start-failed', handlers);
    }
    return turn;
  }

  // Stops the current turn without reporting an outcome.
  stop() {
    const t = this.active;
    if (!t) return;
    this.active = null;
    this.#clearAll(t);
    try { t.rec.abort(); } catch { /* already stopped */ }
  }

  #handle(name, e, t, { status, timer, clear, handlers }) {
    switch (name) {
      case 'start':
        clear('start');
        status('listening', { lang: t.lang });
        break;
      case 'audiostart':
        status('mic-on');
        // The mic is open; if no sound arrives, the wrong input device may be selected.
        timer('silentMic', this.limits.silentMicMs, () => status('no-sound-yet'));
        break;
      case 'soundstart':
        t.heardSound = true;
        clear('silentMic');
        status('sound');
        break;
      case 'speechstart':
        t.heardSpeech = true;
        clear('silentMic');
        status('speech');
        break;
      case 'result': {
        clear('afterSpeech');
        let interim = '';
        for (let i = e.resultIndex ?? 0; i < e.results.length; i++) {
          const r = e.results[i];
          if (r.isFinal) {
            t.finalText += r[0].transcript;
            t.confidence = r[0].confidence ?? null;
            t.alternatives = Array.from({ length: r.length }, (_, k) => r[k]?.transcript).slice(1).filter(Boolean);
          } else {
            interim += r[0].transcript;
          }
        }
        t.interim = interim;
        const text = (t.finalText + interim).trim();
        if (text) status(interim ? 'interim' : 'final', { text });
        break;
      }
      case 'speechend':
        status('speech-end');
        // Chrome normally delivers the result and ends soon after speech stops.
        timer('afterSpeech', this.limits.afterSpeechMs, () => this.#settle(t, 'no-result', handlers));
        break;
      case 'nomatch':
        t.error = t.error ?? 'no-result';
        break;
      case 'error':
        // no-speech and aborted are not failures: onend decides what happened.
        if (e?.error === 'no-speech' || e?.error === 'aborted') t.silent = e.error;
        else t.error = e?.error || 'unknown';
        break;
      case 'end':
        this.#finish(t, handlers);
        break;
      default:
        break;
    }
  }

  #finish(t, handlers) {
    if (t.done) return;
    t.done = true;
    this.#clearAll(t);
    if (this.active === t) this.active = null;
    handlers.onStatus?.('ended');
    const text = t.finalText.trim() || t.interim.trim(); // Chrome occasionally ends with only an interim result
    if (text) return handlers.onFinal?.({ text, alternatives: t.alternatives, confidence: t.confidence, lang: t.lang });
    if (t.error) return handlers.onError?.(t.error);
    handlers.onEmpty?.(t.heardSpeech || t.heardSound ? 'no-result' : 'no-speech');
  }

  // Ends a turn that stalled: use whatever was recognised, otherwise report `code`.
  #settle(t, code, handlers) {
    if ((t.finalText + t.interim).trim()) {
      try { t.rec.abort(); } catch { /* ignore */ }
      return this.#finish(t, handlers);
    }
    return this.#fail(t, code, handlers);
  }

  #fail(t, code, handlers) {
    if (t.done) return;
    t.done = true;
    this.#clearAll(t);
    if (this.active === t) this.active = null;
    try { t.rec.abort(); } catch { /* ignore */ }
    handlers.onStatus?.('ended');
    handlers.onError?.(code);
  }

  #clearAll(t) {
    for (const id of Object.values(t.timers)) this.clearTimer(id);
    t.timers = {};
  }
}

// What the page says for each recognition status.
export function recognitionStatusText(kind, detail = {}, { language } = {}) {
  switch (kind) {
    case 'starting': return 'Starting the microphone…';
    case 'listening': return `Listening in ${language ?? detail.lang}. Speak now.`;
    case 'mic-on': return `Microphone on (${language ?? ''}). Speak now.`.replace(' ()', '');
    case 'no-sound-yet': return 'The microphone is on but no sound is reaching it. Check that the right microphone is selected (click the mic icon in the address bar) and that it is not muted.';
    case 'sound': return 'Hearing sound…';
    case 'speech': return 'Hearing speech…';
    case 'interim': return 'Recognising…';
    case 'final': return 'Got it.';
    case 'speech-end': return 'Processing what you said…';
    case 'ended': return '';
    default: return '';
  }
}

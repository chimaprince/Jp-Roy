// Pure helpers for the voice page. No DOM, no network: the page (app.js) uses
// them, and the tests run them in Node.
//
// Voice now runs on the server: the page records Roy's answer, uploads it,
// and Qwen turns it into text (qwen3-asr-flash); the teacher's replies come
// back as Qwen audio (qwen3-tts-flash). The browser's own speech recognition
// and speech synthesis are not used, so this works the same on iPhone Safari.

// The language the lesson expects next: zh-CN (Mandarin) or en-US (English).
// It is sent to the server as the speech recognition language hint.
export function recognitionLang(lang) {
  return lang === 'zh-CN' ? 'zh-CN' : 'en-US';
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

// ---------- page states ----------

export const STATES = {
  idle: { badge: 'IDLE', button: '🎙 START TALKING' },
  listening: { badge: 'LISTENING', button: '✋ DONE TALKING' },
  captured: { badge: 'AUDIO CAPTURED', button: '⏳ SENDING…' },
  transcribed: { badge: 'TRANSCRIPT RECEIVED', button: '⏳ THINKING…' },
  processing: { badge: 'TEACHER THINKING', button: '⏳ THINKING…' },
  preparing: { badge: 'PREPARING TEACHER VOICE', button: '⏳ PREPARING…' },
  ready: { badge: 'TEACHER AUDIO READY', button: '🔊 TEACHER SPEAKING' },
  speaking: { badge: 'TEACHER SPEAKING', button: '🔊 TEACHER SPEAKING' },
};

// States in which a tap on the big button is ignored (work is under way).
export const BUSY_STATES = new Set(['captured', 'transcribed', 'processing', 'preparing']);

// ---------- messages ----------

export function friendlyError(err) {
  const code = err?.code;
  if (code === 'ai_not_configured') return 'The AI teacher is not set up on the server (DASHSCOPE_API_KEY is missing).';
  if (code === 'ai_request_failed') return "The AI teacher (Qwen) didn't answer. Check the server's internet connection and try again.";
  if (VOICE_ERRORS[code]) return VOICE_ERRORS[code];
  if (err?.name === 'TypeError' || /Failed to fetch|NetworkError|Load failed/i.test(err?.message ?? '')) {
    return "Can't reach the tutor server. Is it still running? Check the terminal, then try again.";
  }
  if (code === 'server_error' || err?.status >= 500) return 'The tutor server had a problem. Try again; if it keeps happening, check the terminal.';
  return err?.message || 'Something went wrong. Try again.';
}

export const VOICE_ERRORS = {
  'insecure-context': 'This page was opened over plain http:// from another device, so the browser blocks the microphone. Type your answers below, or open the tutor over https:// (see "Testing on a phone" in the README).',
  unsupported: 'This browser cannot record audio. Update the browser (iPhone: iOS 14.3 or later), or type your answer below.',
  'not-allowed': 'Microphone access is blocked. Allow the microphone for this site (iPhone: the "aA" menu › Website Settings › Microphone), then tap START TALKING. You can also type below.',
  'no-mic': 'No microphone was found. Connect or enable one and tap START TALKING, or type below.',
  'mic-busy': 'The microphone is in use by another app or tab. Close it, then tap START TALKING.',
  'no-speech': "I didn't hear anything. Tap START TALKING and speak a little louder.",
  asr_empty: 'Your recording reached Qwen, but no words were recognised. Tap START TALKING and say it again, a little louder and closer to the phone.',
  asr_failed: "Qwen speech recognition didn't answer. Your answer was not counted. Tap RETRY to send the same recording again, or START TALKING to record it again.",
  asr_bad_audio: 'The recording format was not accepted. Tap START TALKING to try again, or type below.',
  asr_no_audio: 'The recording was empty. Tap START TALKING and speak.',
  audio_too_large: 'That recording was too long. Keep each answer under about a minute.',
  tts_failed: "The teacher's voice (Qwen) could not be produced for this reply. Read it in the conversation below; the lesson carries on.",
  tts_expired: "The teacher's audio for this reply has expired. Read it in the conversation below.",
  'play-blocked': 'The phone blocked the teacher audio. Tap START TALKING once to allow sound, then carry on.',
};

// ---------- recording helpers ----------

// Recording formats, most preferred first. iPhone Safari records audio/mp4;
// Chrome and Firefox record audio/webm.
const RECORDER_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];

export function pickRecorderType(isTypeSupported) {
  if (typeof isTypeSupported !== 'function') return '';
  return RECORDER_TYPES.find((t) => { try { return isTypeSupported(t); } catch { return false; } }) ?? '';
}

// The upload's Content-Type: the recorder's type without codec details.
export function uploadType(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  return base || 'audio/mp4';
}

// Mix channels to mono and resample to `rate` (linear interpolation; plenty
// for speech recognition).
export function toMono(channels) {
  if (channels.length === 1) return Float32Array.from(channels[0]);
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i += 1) out[i] += ch[i] / channels.length;
  return out;
}

export function resample(samples, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const length = Math.max(1, Math.round(samples.length * toRate / fromRate));
  const out = new Float32Array(length);
  const step = fromRate / toRate;
  for (let i = 0; i < length; i += 1) {
    const pos = i * step;
    const a = Math.floor(pos);
    const b = Math.min(a + 1, samples.length - 1);
    const frac = pos - a;
    out[i] = (samples[a] ?? 0) * (1 - frac) + (samples[b] ?? 0) * frac;
  }
  return out;
}

// 16-bit PCM mono WAV. Every speech recogniser accepts it, whatever format
// the phone recorded in.
export function encodeWav(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const text = (offset, s) => { for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i)); };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(buffer);
}

// A short silent WAV, played on a tap so iPhone Safari lets the page play
// the teacher's audio later without another tap.
export function silentWav() {
  return encodeWav(new Float32Array(800), 16000);
}

// ---------- end of speech ----------
//
// Fed the microphone level every ~100 ms. Says 'speech' when Roy starts
// talking, 'done' after he has been quiet for `quietMs`, and 'nothing' if no
// speech starts within `waitMs`. `maxMs` caps a recording.

export class SilenceDetector {
  constructor({ threshold = 0.02, quietMs = 1500, waitMs = 8000, maxMs = 30000, minSpeechMs = 250 } = {}) {
    Object.assign(this, { threshold, quietMs, waitMs, maxMs, minSpeechMs });
    this.startedAt = null;
    this.loudSince = null;
    this.speaking = false;
    this.lastLoud = null;
  }

  feed(level, now) {
    if (this.startedAt === null) this.startedAt = now;
    const loud = level >= this.threshold;
    if (loud) {
      this.lastLoud = now;
      if (this.loudSince === null) this.loudSince = now;
      if (!this.speaking && now - this.loudSince >= this.minSpeechMs) { this.speaking = true; return 'speech'; }
    } else {
      this.loudSince = null;
    }
    if (now - this.startedAt >= this.maxMs) return this.speaking ? 'done' : 'nothing';
    if (this.speaking && !loud && now - this.lastLoud >= this.quietMs) return 'done';
    if (!this.speaking && now - this.startedAt >= this.waitMs) return 'nothing';
    return null;
  }
}

// Root-mean-square level of a block of samples (0 silent … 1 full scale).
export function rms(samples) {
  if (!samples?.length) return 0;
  let sum = 0;
  for (const v of samples) sum += v * v;
  return Math.sqrt(sum / samples.length);
}

// The line to show for a teacher reply: the on-screen text if the tutor gave
// one, else what is said.
export function lineText(seg) {
  return seg?.show ?? seg?.text ?? '';
}

// Playback speed for a line: slow lines are played a little slower.
export function playbackRate(seg) {
  const r = Number(seg?.rate);
  return Number.isFinite(r) && r > 0 && r < 1 ? Math.max(0.7, r) : 1;
}

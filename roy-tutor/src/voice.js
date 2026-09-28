// Server-side voice: Qwen speech recognition (ASR) and Qwen speech synthesis
// (TTS). The browser only records audio and plays audio; everything that needs
// DASHSCOPE_API_KEY happens here, and the key never leaves the server.
//
//   ASR  qwen3-asr-flash, OpenAI-compatible chat completions with an
//        input_audio part (Singapore: dashscope-intl.aliyuncs.com).
//   TTS  qwen3-tts-flash, DashScope multimodal-generation endpoint. Qwen
//        returns a short-lived audio URL (or inline data); the server fetches
//        it and relays the bytes, so the browser never sees Qwen URLs.

export const ASR_DEFAULT_MODEL = 'qwen3-asr-flash';
export const ASR_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const TTS_DEFAULT_MODEL = 'qwen3-tts-flash';
export const TTS_DEFAULT_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const TTS_DEFAULT_VOICE = 'Cherry';

// Base64 audio must stay under Qwen's 10 MB data-URL limit.
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;
const MAX_TTS_CHARS = 500;
const TIMEOUT_MS = 30_000;

export function voiceSettings(env = process.env) {
  return {
    apiKey: env.DASHSCOPE_API_KEY || '',
    asrModel: env.QWEN_ASR_MODEL || ASR_DEFAULT_MODEL,
    asrBaseURL: (env.QWEN_ASR_BASE_URL || ASR_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    ttsModel: env.QWEN_TTS_MODEL || TTS_DEFAULT_MODEL,
    ttsURL: env.QWEN_TTS_URL || TTS_DEFAULT_URL,
    ttsVoice: env.QWEN_TTS_VOICE || TTS_DEFAULT_VOICE,
  };
}

export class VoiceError extends Error {
  constructor(code, message, { status = 502, detail } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.detail = detail; // server log only, never sent to the browser
  }
}

// Page language → Qwen ASR language hint.
export function asrLanguage(lang) {
  return String(lang ?? '').toLowerCase().startsWith('en') ? 'en' : 'zh';
}

// Mandarin anywhere in the line → Chinese voice mode (it reads the English
// around a term naturally); otherwise English.
export function ttsLanguage(text) {
  return /\p{Script=Han}/u.test(String(text)) ? 'Chinese' : 'English';
}

const AUDIO_TYPES = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg']);

export function audioMime(contentType) {
  const mime = String(contentType ?? '').split(';')[0].trim().toLowerCase();
  return AUDIO_TYPES.has(mime) ? mime : null;
}

// The transcript in a chat-completions reply. Content can be a string or a
// list of parts, depending on the API version.
export function parseAsrReply(reply) {
  const message = reply?.choices?.[0]?.message;
  let text = message?.content;
  if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
  text = String(text ?? '').trim();
  const info = (message?.annotations ?? []).find((a) => a?.type === 'audio_info');
  return { text, detectedLanguage: info?.language ?? null };
}

// The audio in a TTS reply: inline base64 data, or a URL to fetch.
export function parseTtsReply(reply) {
  const audio = reply?.output?.audio;
  if (audio?.data) return { data: Buffer.from(audio.data, 'base64') };
  if (audio?.url) return { url: audio.url };
  return {};
}

function mimeFromBytes(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  return 'audio/wav';
}

export function createVoice({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const s = voiceSettings(env);
  const info = { asrModel: s.asrModel, asrBaseURL: s.asrBaseURL, ttsModel: s.ttsModel, ttsURL: s.ttsURL, ttsVoice: s.ttsVoice };
  const configured = Boolean(s.apiKey);

  async function call(url, init, what) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new VoiceError(`${what}_failed`, `Could not reach Qwen ${what.toUpperCase()}.`, { detail: [err.message, err.cause?.code, err.cause?.message].filter(Boolean).join(' - ') });
    }
    return res;
  }

  function requireKey(what) {
    if (!configured) throw new VoiceError('ai_not_configured', 'Qwen is not configured: DASHSCOPE_API_KEY is missing.', { status: 503 });
    return { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' };
  }

  return {
    configured,
    ...info,

    // audio: Buffer; mime: e.g. audio/wav; lang: the page's zh-CN / en-US.
    async transcribe(audio, mime, lang) {
      const headers = requireKey('asr');
      if (!audio?.length) throw new VoiceError('asr_no_audio', 'No audio was received.', { status: 400 });
      const language = asrLanguage(lang);
      const body = {
        model: s.asrModel,
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: `data:${mime};base64,${audio.toString('base64')}` } }] }],
        stream: false,
        asr_options: { language, enable_itn: false },
      };
      log(`[voice] -> Qwen ASR model=${s.asrModel} language=${language} audio=${mime} ${audio.length} bytes`);
      const res = await call(`${s.asrBaseURL}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) }, 'asr');
      const raw = await res.text();
      if (!res.ok) throw new VoiceError('asr_failed', `Qwen speech recognition failed (status ${res.status}).`, { detail: raw.slice(0, 500) });
      let reply;
      try { reply = JSON.parse(raw); } catch { throw new VoiceError('asr_failed', 'Qwen speech recognition sent an unreadable reply.', { detail: raw.slice(0, 500) }); }
      const out = parseAsrReply(reply);
      log(`[voice] <- Qwen ASR ${out.text ? `${out.text.length} chars` : 'empty'}${out.detectedLanguage ? ` detected=${out.detectedLanguage}` : ''}`);
      if (!out.text) throw new VoiceError('asr_empty', 'No words were recognised in the recording.', { status: 422 });
      return { text: out.text, language: lang, detectedLanguage: out.detectedLanguage, model: s.asrModel };
    },

    // One spoken line → { audio: Buffer, mime }.
    async synthesize(text) {
      const headers = requireKey('tts');
      const clean = String(text ?? '').trim().slice(0, MAX_TTS_CHARS);
      if (!clean) throw new VoiceError('tts_failed', 'Nothing to say.', { status: 400 });
      const language = ttsLanguage(clean);
      const body = { model: s.ttsModel, input: { text: clean, voice: s.ttsVoice, language_type: language } };
      log(`[voice] -> Qwen TTS model=${s.ttsModel} voice=${s.ttsVoice} language=${language} ${clean.length} chars`);
      const res = await call(s.ttsURL, { method: 'POST', headers, body: JSON.stringify(body) }, 'tts');
      const raw = await res.text();
      if (!res.ok) throw new VoiceError('tts_failed', `Qwen speech synthesis failed (status ${res.status}).`, { detail: raw.slice(0, 500) });
      let reply;
      try { reply = JSON.parse(raw); } catch { throw new VoiceError('tts_failed', 'Qwen speech synthesis sent an unreadable reply.', { detail: raw.slice(0, 500) }); }
      const found = parseTtsReply(reply);
      let audio = found.data;
      if (!audio && found.url) {
        // The URL is Qwen's temporary download link; no key is needed for it.
        const file = await call(found.url, { method: 'GET' }, 'tts');
        if (!file.ok) throw new VoiceError('tts_failed', `Could not download the Qwen audio (status ${file.status}).`);
        audio = Buffer.from(await file.arrayBuffer());
      }
      if (!audio?.length) throw new VoiceError('tts_failed', 'Qwen speech synthesis returned no audio.', { detail: raw.slice(0, 500) });
      log(`[voice] <- Qwen TTS ${audio.length} bytes`);
      return { audio, mime: mimeFromBytes(audio) };
    },
  };
}

// Teacher lines waiting to be spoken. Each line of a tutor reply gets an id;
// synthesis starts straight away, and the page fetches the audio by id. Only
// text the tutor itself said can be synthesised: the browser never sends text
// to speak. Old entries are dropped.
export class SpeechStore {
  constructor(voice, { max = 100, log = console.error } = {}) {
    this.voice = voice;
    this.max = max;
    this.log = log;
    this.items = new Map();
    this.next = 1;
  }

  // Adds `audio` ids to a tutor result's spoken lines (a copy; the engine's
  // result is not changed).
  attach(result) {
    if (!this.voice?.configured || !Array.isArray(result?.say)) return result;
    const say = result.say.map((line) => {
      if (!String(line.text ?? '').trim()) return line;
      const id = `${Date.now().toString(36)}${(this.next++).toString(36)}`;
      const job = this.voice.synthesize(line.text);
      job.catch((err) => this.log(`[voice] TTS failed for line ${id}: ${err.message}${err.detail ? ` ${err.detail}` : ''}`));
      this.items.set(id, job);
      while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
      return { ...line, audio: id };
    });
    return { ...result, say };
  }

  get(id) {
    return this.items.get(String(id)) ?? null;
  }
}

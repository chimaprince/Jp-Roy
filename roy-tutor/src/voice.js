// Server-side voice: Qwen speech recognition (ASR) and Qwen speech synthesis
// (TTS). The browser only records audio and plays audio; everything that needs
// DASHSCOPE_API_KEY happens here, and the key never leaves the server.
//
//   ASR  qwen-audio-3.1-asr-flash, DashScope native multimodal-generation
//        endpoint on the Singapore workspace host (synchronous: audio in,
//        output.text back), with the current lesson term as context.
//        (qwen3-asr-* models still use the OpenAI-compatible endpoint.)
//   TTS  qwen3-tts-instruct-flash, DashScope multimodal-generation endpoint
//        (Singapore), with speaking-style instructions for a clear, patient
//        Mandarin teacher. Qwen
//        returns a short-lived audio URL (or inline data); the server fetches
//        it and relays the bytes, so the browser never sees Qwen URLs.

export const ASR_DEFAULT_MODEL = 'qwen-audio-3.1-asr-flash';
export const ASR_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
export const NATIVE_PATH = '/api/v1/services/aigc/multimodal-generation/generation';
// Singapore workspace-specific host (Model Studio workspace, International).
// The native endpoint is taken from the host of QWEN_ASR_BASE_URL, unless
// QWEN_ASR_URL gives it in full.
export const ASR_WORKSPACE_URL_FORMAT = 'https://<WORKSPACE_ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
export const ASR_WORKSPACE_NATIVE_URL_FORMAT = `https://<WORKSPACE_ID>.ap-southeast-1.maas.aliyuncs.com${NATIVE_PATH}`;

// qwen3-asr-* speak the OpenAI-compatible protocol; qwen-audio-*-asr and
// others use DashScope's native multimodal-generation protocol.
export function asrProtocol(model) {
  return /^qwen3-asr/i.test(model) ? 'openai' : 'native';
}

// The full URL an ASR request goes to.
export function asrEndpoint({ model, baseURL, url }) {
  if (asrProtocol(model) === 'openai') return `${baseURL}/chat/completions`;
  if (url) return url;
  try { return `${new URL(baseURL).origin}${NATIVE_PATH}`; } catch { return baseURL; }
}

// A problem with the ASR endpoint setting that would fail every request, or null.
export function asrEndpointProblem(url) {
  if (/[<>]|WORKSPACE_ID/i.test(url)) return `The ASR endpoint still contains the placeholder: put your workspace ID into QWEN_ASR_BASE_URL (${ASR_WORKSPACE_URL_FORMAT}).`;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return `The ASR endpoint must start with https:// (got ${u.protocol}).`;
  } catch {
    return `The ASR endpoint is not a valid URL: ${url}`;
  }
  return null;
}

// Recognition context for Mandarin medical Chinese: what the lesson is about
// and the current JH Medics term, so the recogniser expects it.
export function asrContext(entry) {
  const parts = ['医学中文课（JH Medics 医学术语）。学生在练习医学普通话，可能说普通话，也可能说英语。'];
  if (entry?.mandarin) {
    const extra = [entry.pinyin, entry.english].filter(Boolean).join('，');
    parts.push(`当前术语：${entry.mandarin}${extra ? `（${extra}）` : ''}。`);
  }
  return parts.join('');
}
export const TTS_DEFAULT_MODEL = 'qwen3-tts-instruct-flash';
export const TTS_DEFAULT_URL = 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
export const TTS_DEFAULT_VOICE = 'Cherry';
// Speaking style for lines with Mandarin in them (sent as `instructions`):
// standard Putonghua, every tone clear, a little slower than conversation,
// like a patient medical Chinese teacher modelling pronunciation.
export const TTS_DEFAULT_INSTRUCTIONS_ZH = '请用标准普通话朗读，发音清晰准确，每个字的声调都要读清楚，语速适中偏慢，语气亲切、耐心、专业，像一位医学中文老师在给学生示范发音。句子里的英文单词用自然的英语读出。';
export const TTS_DEFAULT_INSTRUCTIONS_EN = 'Speak clear, natural English at a moderate pace, in a warm, patient and professional tone, like a medical Chinese teacher talking to a student.';

// Base64 audio must stay under Qwen's 10 MB data-URL limit.
export const MAX_AUDIO_BYTES = 7 * 1024 * 1024;
const MAX_TTS_CHARS = 500;
const TIMEOUT_MS = 30_000;

export function voiceSettings(env = process.env) {
  // Values are trimmed: a stray space or CR from a Windows .env must not
  // change which model or protocol is used.
  env = Object.fromEntries(Object.entries(env).map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]));
  return {
    apiKey: env.DASHSCOPE_API_KEY || '',
    asrModel: env.QWEN_ASR_MODEL || ASR_DEFAULT_MODEL,
    asrBaseURL: (env.QWEN_ASR_BASE_URL || ASR_DEFAULT_BASE_URL).replace(/\/+$/, ''),
    asrURL: env.QWEN_ASR_URL || '',
    asrContextOn: !/^(0|false|no|off)$/i.test(env.QWEN_ASR_CONTEXT || ''),
    ttsModel: env.QWEN_TTS_MODEL || TTS_DEFAULT_MODEL,
    ttsURL: env.QWEN_TTS_URL || TTS_DEFAULT_URL,
    ttsVoice: env.QWEN_TTS_VOICE || TTS_DEFAULT_VOICE,
    ttsInstructionsZh: env.QWEN_TTS_INSTRUCTIONS || TTS_DEFAULT_INSTRUCTIONS_ZH,
    ttsInstructionsEn: env.QWEN_TTS_INSTRUCTIONS_EN || TTS_DEFAULT_INSTRUCTIONS_EN,
  };
}

export class VoiceError extends Error {
  constructor(code, message, { status = 502, detail, httpStatus = null } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.httpStatus = httpStatus; // Qwen's HTTP status, if Qwen answered
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

// The transcript in an ASR reply. Native replies carry output.text (or
// sentences, or a message); OpenAI-compatible replies carry choices. Content
// can be a string or a list of parts.
export function parseAsrReply(reply) {
  const out = reply?.output;
  if (out) {
    const sentences = [out.sentences, out.sentence].find((x) => Array.isArray(x));
    let text = typeof out.text === 'string' ? out.text
      : sentences ? sentences.map((x) => x?.text ?? '').join('')
      : typeof out.sentence?.text === 'string' ? out.sentence.text
      : out.choices?.[0]?.message?.content ?? '';
    if (Array.isArray(text)) text = text.map((p) => (typeof p === 'string' ? p : p?.text ?? '')).join('');
    return { text: String(text ?? '').trim(), detectedLanguage: out.language ?? null };
  }
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

// What a browser needs to know to play the audio: container, encoding and
// length. Returns null for anything that is not WAV or MP3.
export function audioInfo(buf) {
  if (!buf?.length) return null;
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12;
    let fmt = null;
    let dataBytes = null;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
      if (id === 'data') { dataBytes = Math.min(size, buf.length - off - 8); break; }
      off += 8 + size + (size % 2);
    }
    if (!fmt || dataBytes === null) return null;
    const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
    return { container: 'wav', encoding: fmt.format === 1 ? 'pcm' : `format ${fmt.format}`, ...fmt, seconds: bytesPerSecond ? dataBytes / bytesPerSecond : 0 };
  }
  if (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return { container: 'mp3', encoding: 'mp3', seconds: null };
  return null;
}

function mimeFromBytes(buf) {
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buf.length >= 3 && (buf.toString('ascii', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'audio/mpeg';
  return 'audio/wav';
}

export function createVoice({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const s = voiceSettings(env);
  const asrURL = asrEndpoint({ model: s.asrModel, baseURL: s.asrBaseURL, url: s.asrURL });
  const info = { asrModel: s.asrModel, asrBaseURL: s.asrBaseURL, asrURL, asrProtocol: asrProtocol(s.asrModel), ttsModel: s.ttsModel, ttsURL: s.ttsURL, ttsVoice: s.ttsVoice, ttsInstructions: s.ttsInstructionsZh };
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

    // audio: Buffer; mime: e.g. audio/wav; lang: the page's zh-CN / en-US;
    // entry: the current curriculum entry (recognition context), optional.
    async transcribe(audio, mime, lang, { entry = null } = {}) {
      const headers = requireKey('asr');
      if (!audio?.length) throw new VoiceError('asr_no_audio', 'No audio was received.', { status: 400 });
      const problem = asrEndpointProblem(asrURL);
      if (problem) throw new VoiceError('asr_failed', 'Qwen speech recognition is set up wrongly on the server.', { detail: problem });
      const language = asrLanguage(lang);
      const dataUri = `data:${mime};base64,${audio.toString('base64')}`;
      const context = s.asrContextOn ? asrContext(entry) : '';

      // Request variants, fullest first. Only when Qwen rejects one as invalid
      // (HTTP 400) is the next, plainer one tried; every attempt is logged.
      let variants;
      if (asrProtocol(s.asrModel) === 'openai') {
        variants = [{
          name: 'openai',
          body: {
            model: s.asrModel,
            messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] }],
            stream: false,
            asr_options: { language, enable_itn: false },
          },
        }];
      } else {
        const wav = audioInfo(audio);
        const format = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'mp4', 'audio/m4a': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/webm': 'webm', 'audio/ogg': 'ogg' }[mime] ?? 'wav';
        const audioParams = { format, ...(wav?.sampleRate ? { sample_rate: String(wav.sampleRate) } : {}) };
        const user = { role: 'user', content: [{ type: 'input_audio', input_audio: { data: dataUri } }] };
        variants = [
          { name: 'context+language', body: { model: s.asrModel, input: { messages: [{ role: 'system', content: [{ text: context }] }, user] }, parameters: { ...audioParams, language_hints: [language] } } },
          { name: 'language', body: { model: s.asrModel, input: { messages: [user] }, parameters: { ...audioParams, language_hints: [language] } } },
          { name: 'plain', body: { model: s.asrModel, input: { messages: [user] }, parameters: audioParams } },
        ];
        if (!context) variants.shift();
      }

      let res;
      let raw;
      let used;
      for (const v of variants) {
        used = v.name;
        log(`[voice] -> Qwen ASR model=${s.asrModel} request=${v.name} language=${language} audio=${mime} ${audio.length} bytes${v.name.includes('context') ? ` context="${context}"` : ''}`);
        res = await call(asrURL, { method: 'POST', headers, body: JSON.stringify(v.body) }, 'asr');
        raw = await res.text();
        if (res.status !== 400 || v === variants.at(-1)) break;
        log(`[voice]    Qwen ASR rejected request=${v.name} (400): ${raw.slice(0, 300)} - trying a plainer request`);
      }
      if (!res.ok) throw new VoiceError('asr_failed', `Qwen speech recognition failed (status ${res.status}).`, { detail: raw.slice(0, 500), httpStatus: res.status });
      let reply;
      try { reply = JSON.parse(raw); } catch { throw new VoiceError('asr_failed', 'Qwen speech recognition sent an unreadable reply.', { detail: raw.slice(0, 500), httpStatus: res.status }); }
      const out = parseAsrReply(reply);
      log(`[voice] <- Qwen ASR ${res.status} ${out.text ? `${out.text.length} chars` : 'empty'}${out.detectedLanguage ? ` detected=${out.detectedLanguage}` : ''}`);
      if (!out.text) throw new VoiceError('asr_empty', 'No words were recognised in the recording.', { status: 422, httpStatus: res.status, detail: raw.slice(0, 500) });
      return { text: out.text, language: lang, detectedLanguage: out.detectedLanguage, model: s.asrModel, status: res.status, request: used };
    },

    // One spoken line → { audio: Buffer, mime, status } (status: Qwen's HTTP status).
    async synthesize(text) {
      const headers = requireKey('tts');
      const clean = String(text ?? '').trim().slice(0, MAX_TTS_CHARS);
      if (!clean) throw new VoiceError('tts_failed', 'Nothing to say.', { status: 400 });
      const language = ttsLanguage(clean);
      const instructions = language === 'Chinese' ? s.ttsInstructionsZh : s.ttsInstructionsEn;
      const body = { model: s.ttsModel, input: { text: clean, voice: s.ttsVoice, language_type: language, instructions, optimize_instructions: false } };
      log(`[voice] -> Qwen TTS model=${s.ttsModel} voice=${s.ttsVoice} language=${language} ${clean.length} chars`);
      const res = await call(s.ttsURL, { method: 'POST', headers, body: JSON.stringify(body) }, 'tts');
      const raw = await res.text();
      if (!res.ok) throw new VoiceError('tts_failed', `Qwen speech synthesis failed (status ${res.status}).`, { detail: raw.slice(0, 500), httpStatus: res.status });
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
      return { audio, mime: mimeFromBytes(audio), status: res.status };
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
    this.byText = new Map(); // text -> audio job, so repeated lines are synthesised once
    this.next = 1;
  }

  // The audio job for a line of text: reused if this text was synthesised
  // before (Listen & Learn repeats, the same word again); failures are retried.
  #job(text) {
    let job = this.byText.get(text);
    if (!job) {
      job = this.voice.synthesize(text);
      this.byText.set(text, job);
      job.catch(() => { if (this.byText.get(text) === job) this.byText.delete(text); });
      while (this.byText.size > this.max * 3) this.byText.delete(this.byText.keys().next().value);
    }
    return job;
  }

  // Adds `audio` ids to a tutor result's spoken lines (a copy; the engine's
  // result is not changed).
  attach(result) {
    return this.attachTo(result, 'say');
  }

  // Same, for any list of spoken lines (Listen & Learn uses `steps`).
  attachTo(result, field) {
    if (!this.voice?.configured || !Array.isArray(result?.[field])) return result;
    const lines = result[field].map((line) => {
      if (!String(line.text ?? '').trim()) return line;
      const id = `${Date.now().toString(36)}${(this.next++).toString(36)}`;
      const job = this.#job(line.text);
      job.catch((err) => this.log(`[voice] TTS failed for line ${id}: ${err.message}${err.detail ? ` ${err.detail}` : ''}`));
      this.items.set(id, job);
      while (this.items.size > this.max) this.items.delete(this.items.keys().next().value);
      return { ...line, audio: id };
    });
    return { ...result, [field]: lines };
  }

  get(id) {
    return this.items.get(String(id)) ?? null;
  }
}

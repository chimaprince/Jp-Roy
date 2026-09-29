// Server-side voice: Qwen ASR (qwen-audio-3.1-asr-flash) and Qwen TTS (qwen3-tts-instruct-flash).
// Real Qwen is replaced by a local stand-in server that checks every request
// the tutor makes, so these tests run offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createVoice, voiceSettings, SpeechStore, parseAsrReply, parseTtsReply, asrLanguage, ttsLanguage, audioMime,
  ASR_DEFAULT_MODEL, ASR_DEFAULT_BASE_URL, TTS_DEFAULT_MODEL, TTS_DEFAULT_URL, TTS_DEFAULT_INSTRUCTIONS_ZH, TTS_DEFAULT_INSTRUCTIONS_EN, audioInfo, asrEndpointProblem, asrContext, asrProtocol, asrEndpoint,
} from '../src/voice.js';
import {
  encodeWav, resample, toMono, SilenceDetector, rms, pickRecorderType, uploadType, playbackRate, STATES, BUSY_STATES, silentWav,
} from '../public/voice-core.js';
import { freePort, cleanEnv } from './helpers.js';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = 'test-key-not-real-1234567890';


// ---------- browser helpers (recording and playback) ----------

test('recordings become 16-bit mono WAV that any recogniser accepts', () => {
  const wav = encodeWav(new Float32Array([0, 0.5, -0.5, 1, -1, 2]), 16000);
  const b = Buffer.from(wav);
  assert.equal(b.toString('ascii', 0, 4), 'RIFF');
  assert.equal(b.toString('ascii', 8, 12), 'WAVE');
  assert.equal(b.readUInt16LE(22), 1, 'mono');
  assert.equal(b.readUInt32LE(24), 16000, 'sample rate');
  assert.equal(b.readUInt16LE(34), 16, '16-bit');
  assert.equal(b.readUInt32LE(40), 12, 'data bytes');
  assert.equal(b.length, 44 + 12);
  assert.equal(b.readInt16LE(44 + 2 * 3), 32767, 'full scale');
  assert.equal(b.readInt16LE(44 + 2 * 5), 32767, 'clipped, not wrapped');
  assert.equal(Buffer.from(silentWav()).toString('ascii', 0, 4), 'RIFF');
});

test('48 kHz stereo from the phone becomes 16 kHz mono', () => {
  const left = new Float32Array(4800).fill(0.4);
  const right = new Float32Array(4800).fill(0.2);
  const mono = toMono([left, right]);
  assert.ok(Math.abs(mono[10] - 0.3) < 1e-6);
  const down = resample(mono, 48000, 16000);
  assert.equal(down.length, 1600);
  assert.ok(Math.abs(down[800] - 0.3) < 1e-6);
  assert.equal(resample(mono, 16000, 16000).length, 4800);
  assert.equal(rms(new Float32Array([0.5, -0.5])), 0.5);
  assert.equal(rms(new Float32Array(0)), 0);
});

test('end of speech: waits for speech, stops after a pause, gives up on silence', () => {
  const d = new SilenceDetector({ threshold: 0.02, quietMs: 1500, waitMs: 8000, maxMs: 30000, minSpeechMs: 200 });
  assert.equal(d.feed(0.001, 0), null);
  assert.equal(d.feed(0.1, 100), null, 'a click is not speech');
  assert.equal(d.feed(0.1, 200), null);
  assert.equal(d.feed(0.1, 300), 'speech');
  assert.equal(d.feed(0.1, 1000), null);
  assert.equal(d.feed(0.001, 1500), null, 'a short pause keeps recording');
  assert.equal(d.feed(0.1, 2000), null);
  assert.equal(d.feed(0.001, 3000), null);
  assert.equal(d.feed(0.001, 3600), 'done');

  const quiet = new SilenceDetector({ waitMs: 8000 });
  for (let t = 0; t < 8000; t += 100) assert.equal(quiet.feed(0.001, t), null);
  assert.equal(quiet.feed(0.001, 8000), 'nothing');

  const long = new SilenceDetector({ maxMs: 30000, minSpeechMs: 0 });
  long.feed(0.2, 0);
  assert.equal(long.feed(0.2, 30000), 'done', 'a recording never runs forever');
});

test('recording format: mp4 on iPhone Safari, webm on Chrome; uploads name the base type', () => {
  const safari = (t) => t === 'audio/mp4';
  const chrome = (t) => t.startsWith('audio/webm');
  assert.equal(pickRecorderType(safari), 'audio/mp4');
  assert.equal(pickRecorderType(chrome), 'audio/webm;codecs=opus');
  assert.equal(pickRecorderType(undefined), '');
  assert.equal(uploadType('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(uploadType(''), 'audio/mp4');
});

test('page states: captured, transcribed, thinking, audio ready and speaking are all distinct', () => {
  const badges = ['captured', 'transcribed', 'processing', 'ready', 'speaking', 'listening', 'idle'].map((s) => STATES[s].badge);
  assert.equal(new Set(badges).size, badges.length);
  assert.equal(STATES.captured.badge, 'AUDIO CAPTURED');
  assert.equal(STATES.transcribed.badge, 'TRANSCRIPT RECEIVED');
  assert.equal(STATES.processing.badge, 'TEACHER THINKING');
  assert.equal(STATES.ready.badge, 'TEACHER AUDIO READY');
  assert.equal(STATES.speaking.badge, 'TEACHER SPEAKING');
  assert.ok(BUSY_STATES.has('processing') && !BUSY_STATES.has('speaking'), 'a tap while the teacher speaks skips ahead');
  assert.equal(playbackRate({ rate: 0.6 }), 0.7);
  assert.equal(playbackRate({}), 1);
});

// ---------- Qwen ASR / TTS client (src/voice.js) ----------

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init = {}) => {
    const call = { url: String(url), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ? JSON.parse(init.body) : null };
    calls.push(call);
    const { status = 200, json, bytes } = await handler(call);
    const raw = bytes ?? Buffer.from(json === undefined ? '' : JSON.stringify(json));
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => raw.toString(),
      arrayBuffer: async () => raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.length),
    };
  };
  return { fn, calls };
}

const WAV = Buffer.from(encodeWav(new Float32Array(1600).fill(0.1), 16000));
const quiet = () => {};

test('defaults: qwen-audio-3.1-asr-flash and qwen3-tts-instruct-flash on the Singapore endpoint', () => {
  const s = voiceSettings({ DASHSCOPE_API_KEY: KEY });
  assert.equal(s.asrModel, 'qwen-audio-3.1-asr-flash');
  assert.equal(s.ttsModel, 'qwen3-tts-instruct-flash');
  assert.equal(ASR_DEFAULT_BASE_URL, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1');
  assert.equal(TTS_DEFAULT_URL, 'https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(s.asrBaseURL, ASR_DEFAULT_BASE_URL);
  assert.equal(s.ttsURL, TTS_DEFAULT_URL);
  assert.equal(ASR_DEFAULT_MODEL, 'qwen-audio-3.1-asr-flash');
  assert.equal(TTS_DEFAULT_MODEL, 'qwen3-tts-instruct-flash');
  const custom = voiceSettings({ QWEN_ASR_MODEL: 'a', QWEN_TTS_MODEL: 'b', QWEN_TTS_VOICE: 'Ethan', QWEN_ASR_BASE_URL: 'http://x/v1/', QWEN_TTS_URL: 'http://y' });
  assert.deepEqual([custom.asrModel, custom.ttsModel, custom.ttsVoice, custom.asrBaseURL, custom.ttsURL], ['a', 'b', 'Ethan', 'http://x/v1', 'http://y']);
});

const WS = 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
const WS_NATIVE = 'https://ws-test123.ap-southeast-1.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const EPIDURAL = { mandarin: '硬膜外', pinyin: 'yìng mó wài', english: 'epidural' };

test('qwen-audio-3.1-asr-flash: DashScope native request on the Singapore workspace host, with lesson context', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { request_id: 'r1', output: { text: '硬膜外' }, usage: { seconds: 1 } } }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_MODEL: 'qwen-audio-3.1-asr-flash', QWEN_ASR_BASE_URL: WS }, fetchImpl: fn, log: quiet });
  assert.equal(voice.asrURL, WS_NATIVE, 'the native endpoint on the workspace host');
  assert.equal(voice.asrProtocol, 'native');
  const out = await voice.transcribe(WAV, 'audio/wav', 'zh-CN', { entry: EPIDURAL });
  assert.equal(out.text, '硬膜外');
  assert.equal(out.status, 200);
  assert.equal(out.request, 'context+language');
  const c = calls[0];
  assert.equal(c.url, WS_NATIVE);
  assert.equal(c.method, 'POST');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.doesNotMatch(JSON.stringify(c.body), new RegExp(KEY), 'the key is not in the request body');
  assert.equal(c.body.model, 'qwen-audio-3.1-asr-flash');
  const [system, user] = c.body.input.messages;
  assert.equal(system.role, 'system');
  assert.match(system.content[0].text, /当前术语：硬膜外（yìng mó wài，epidural）/, 'the current term is the recognition context');
  assert.match(system.content[0].text, /医学/);
  assert.equal(user.role, 'user');
  assert.equal(user.content[0].type, 'input_audio');
  assert.equal(user.content[0].input_audio.data, `data:audio/wav;base64,${WAV.toString('base64')}`);
  assert.deepEqual(c.body.parameters, { format: 'wav', sample_rate: '16000', language_hints: ['zh'] });

  await voice.transcribe(WAV, 'audio/wav', 'en-US', { entry: EPIDURAL });
  assert.deepEqual(calls[1].body.parameters.language_hints, ['en'], 'English exercises hint English');
  const noEntry = await voice.transcribe(WAV, 'audio/wav', 'zh-CN');
  assert.equal(noEntry.request, 'context+language', 'general medical context even without a term');
  assert.doesNotMatch(calls[2].body.input.messages[0].content[0].text, /当前术语/);
  assert.equal(asrContext(null).includes('医学中文'), true);
});

test('qwen-audio ASR: an invalid-request 400 falls back to plainer requests; other errors do not', async () => {
  const bodies = [];
  const { fn } = fakeFetch((c) => {
    bodies.push(c.body);
    return bodies.length < 3 ? { status: 400, json: { code: 'InvalidParameter', message: 'bad field' } } : { json: { output: { text: '硬膜外' } } };
  });
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_BASE_URL: WS }, fetchImpl: fn, log: quiet });
  const out = await voice.transcribe(WAV, 'audio/wav', 'zh-CN', { entry: EPIDURAL });
  assert.equal(out.request, 'plain');
  assert.equal(bodies.length, 3);
  assert.equal(bodies[0].input.messages[0].role, 'system');
  assert.equal(bodies[1].input.messages.length, 1, 'second try: no context');
  assert.equal(bodies[2].parameters.language_hints, undefined, 'third try: no language hint');

  const allBad = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_BASE_URL: WS }, fetchImpl: fakeFetch(() => ({ status: 400, json: { code: 'InvalidParameter' } })).fn, log: quiet });
  await assert.rejects(allBad.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed' && e.httpStatus === 400 && /InvalidParameter/.test(e.detail));

  let n = 0;
  const denied = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_BASE_URL: WS }, fetchImpl: fakeFetch(() => { n += 1; return { status: 403, json: { code: 'AccessDenied.Unpurchased' } }; }).fn, log: quiet });
  await assert.rejects(denied.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.httpStatus === 403 && /Unpurchased/.test(e.detail));
  assert.equal(n, 1, 'a 403 is not retried');
});

test('native ASR reply shapes: output.text, sentences, or a message', () => {
  assert.equal(parseAsrReply({ output: { text: ' 硬膜外。 ' } }).text, '硬膜外。');
  assert.equal(parseAsrReply({ output: { sentences: [{ text: '硬膜' }, { text: '外' }] } }).text, '硬膜外');
  assert.equal(parseAsrReply({ output: { sentence: [{ text: '硬膜外' }] } }).text, '硬膜外');
  assert.equal(parseAsrReply({ output: { choices: [{ message: { content: [{ text: '硬膜外' }] } }] } }).text, '硬膜外');
  assert.equal(parseAsrReply({ output: {} }).text, '');
  assert.equal(asrProtocol('qwen3-asr-flash'), 'openai');
  assert.equal(asrProtocol('qwen-audio-3.1-asr-flash'), 'native');
  assert.equal(asrEndpoint({ model: 'qwen-audio-3.1-asr-flash', baseURL: WS, url: 'https://x.test/full' }), 'https://x.test/full', 'QWEN_ASR_URL wins');
});

test('qwen3-asr-flash (older model) still uses the OpenAI-compatible request', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: '硬膜外', annotations: [{ type: 'audio_info', language: 'zh' }] } }] } }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_MODEL: 'qwen3-asr-flash' }, fetchImpl: fn, log: quiet });
  const out = await voice.transcribe(WAV, 'audio/wav', 'zh-CN');
  assert.deepEqual(out, { text: '硬膜外', language: 'zh-CN', detectedLanguage: 'zh', model: 'qwen3-asr-flash', status: 200, request: 'openai' });
  const c = calls[0];
  assert.equal(c.url, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions');
  assert.equal(c.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.body.model, 'qwen3-asr-flash');
  assert.deepEqual(c.body.asr_options, { language: 'zh', enable_itn: false });
  const part = c.body.messages[0].content[0];
  assert.equal(part.type, 'input_audio');
  assert.equal(part.input_audio.data, `data:audio/wav;base64,${WAV.toString('base64')}`);
  assert.doesNotMatch(JSON.stringify(c.body), new RegExp(KEY), 'the key is not in the request body');

  await voice.transcribe(WAV, 'audio/mp4', 'en-US');
  assert.equal(calls[1].body.asr_options.language, 'en', 'English exercises are recognised as English');
  assert.match(calls[1].body.messages[0].content[0].input_audio.data, /^data:audio\/mp4;base64,/);
});

test('qwen3-asr-flash on the Singapore workspace endpoint reports the HTTP status', async () => {
  const ws = WS;
  const { fn, calls } = fakeFetch(() => ({ json: { choices: [{ message: { content: '硬膜外' } }] } }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_MODEL: 'qwen3-asr-flash', QWEN_ASR_BASE_URL: ws + '/' }, fetchImpl: fn, log: quiet });
  const out = await voice.transcribe(WAV, 'audio/wav', 'zh-CN');
  assert.equal(calls[0].url, `${ws}/chat/completions`);
  assert.equal(calls[0].body.model, 'qwen3-asr-flash');
  assert.equal(out.status, 200);
  assert.equal(asrEndpointProblem(ws), null);
  assert.equal(voice.ttsModel, 'qwen3-tts-instruct-flash', 'TTS is not affected');

  const denied = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_BASE_URL: ws }, fetchImpl: fakeFetch(() => ({ status: 403, json: { code: 'AccessDenied' } })).fn, log: quiet });
  await assert.rejects(denied.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed' && e.httpStatus === 403);
});

test('an unfilled workspace placeholder is caught before any request', async () => {
  const placeholder = 'https://<WORKSPACE_ID>.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';
  assert.match(asrEndpointProblem(placeholder), /placeholder/);
  assert.match(asrEndpointProblem('not a url'), /not a valid URL/);
  const { fn, calls } = fakeFetch(() => ({ json: {} }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_ASR_BASE_URL: placeholder }, fetchImpl: fn, log: quiet });
  await assert.rejects(voice.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed' && /placeholder/.test(e.detail));
  assert.equal(calls.length, 0);
});

test('ASR reply parsing: string or parts; empty is an error, not a blank answer', async () => {
  assert.deepEqual(parseAsrReply({ choices: [{ message: { content: [{ text: 'epi' }, { text: 'dural' }] } }] }), { text: 'epidural', detectedLanguage: null });
  assert.equal(parseAsrReply({}).text, '');
  const { fn } = fakeFetch(() => ({ json: { choices: [{ message: { content: '  ' } }] } }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fn, log: quiet });
  await assert.rejects(voice.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_empty' && e.status === 422);
  await assert.rejects(voice.transcribe(Buffer.alloc(0), 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_no_audio');
});

test('ASR failures are reported with a code, and Qwen\'s error text stays on the server', async () => {
  const { fn } = fakeFetch(() => ({ status: 401, json: { error: { message: 'Incorrect API key provided: test-key...' } } }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fn, log: quiet });
  await assert.rejects(voice.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed' && e.status === 502 && !/API key/.test(e.message) && /Incorrect/.test(e.detail));
  const down = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: async () => { throw new Error('ECONNREFUSED'); }, log: quiet });
  await assert.rejects(down.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'asr_failed');
  const none = createVoice({ env: {}, fetchImpl: fn, log: quiet });
  assert.equal(none.configured, false);
  await assert.rejects(none.transcribe(WAV, 'audio/wav', 'zh-CN'), (e) => e.code === 'ai_not_configured' && e.status === 503);
});

test('TTS request: Chinese mode for lines with Mandarin, the audio URL is downloaded by the server', async () => {
  const { fn, calls } = fakeFetch((c) => (c.method === 'POST'
    ? { json: { output: { audio: { url: 'https://example-oss.test/tts/abc.wav', data: '' } } } }
    : { bytes: WAV }));
  const voice = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_TTS_VOICE: 'Cherry' }, fetchImpl: fn, log: quiet });
  const out = await voice.synthesize('The word is 硬膜外, yìng mó wài.');
  assert.equal(out.mime, 'audio/wav');
  assert.deepEqual(out.audio, WAV);
  assert.equal(calls[0].url, TTS_DEFAULT_URL);
  assert.equal(calls[0].headers.Authorization, `Bearer ${KEY}`);
  assert.deepEqual(calls[0].body, {
    model: 'qwen3-tts-instruct-flash',
    input: { text: 'The word is 硬膜外, yìng mó wài.', voice: 'Cherry', language_type: 'Chinese', instructions: TTS_DEFAULT_INSTRUCTIONS_ZH, optimize_instructions: false },
  });
  assert.match(TTS_DEFAULT_INSTRUCTIONS_ZH, /标准普通话/);
  assert.match(TTS_DEFAULT_INSTRUCTIONS_ZH, /声调/);
  assert.equal(out.status, 200, 'the HTTP status is reported');
  assert.equal(calls[1].url, 'https://example-oss.test/tts/abc.wav');
  assert.equal(calls[1].headers.Authorization, undefined, 'the key is not sent to the download link');
  assert.equal(ttsLanguage('Say it again.'), 'English');
  assert.equal(asrLanguage('en-US'), 'en');
  assert.equal(asrLanguage('zh-CN'), 'zh');
  assert.deepEqual(parseTtsReply({ output: { audio: { data: WAV.toString('base64') } } }).data, WAV);
});

test('English-only lines use the English speaking style; instructions can be set in .env', async () => {
  const { fn, calls } = fakeFetch(() => ({ json: { output: { audio: { data: WAV.toString('base64') } } } }));
  await createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fn, log: quiet }).synthesize('Say it again, slowly.');
  assert.equal(calls[0].body.input.language_type, 'English');
  assert.equal(calls[0].body.input.instructions, TTS_DEFAULT_INSTRUCTIONS_EN);
  const custom = createVoice({ env: { DASHSCOPE_API_KEY: KEY, QWEN_TTS_INSTRUCTIONS: '慢一点', QWEN_TTS_MODEL: 'qwen3-tts-flash', QWEN_TTS_VOICE: 'Serena' }, fetchImpl: fn, log: quiet });
  await custom.synthesize('硬膜外');
  assert.equal(calls[1].body.input.instructions, '慢一点');
  assert.equal(calls[1].body.model, 'qwen3-tts-flash');
  assert.equal(calls[1].body.input.voice, 'Serena');
});

test('playable audio: PCM WAV and MP3 are recognised, anything else is not', () => {
  const info = audioInfo(WAV);
  assert.equal(info.container, 'wav');
  assert.equal(info.encoding, 'pcm');
  assert.equal(info.sampleRate, 16000);
  assert.ok(Math.abs(info.seconds - 0.1) < 1e-6);
  assert.equal(audioInfo(Buffer.from('ID3\x04rest')).container, 'mp3');
  assert.equal(audioInfo(Buffer.from('{"error":"x"}')), null);
  assert.equal(audioInfo(Buffer.alloc(0)), null);
});

test('TTS failures are reported as tts_failed, with Qwen\'s HTTP status (e.g. 403 AccessDenied.Unpurchased)', async () => {
  const denied = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fakeFetch(() => ({ status: 403, json: { code: 'AccessDenied.Unpurchased', message: 'Access to model denied.' } })).fn, log: quiet });
  await assert.rejects(denied.synthesize('你好'), (e) => e.code === 'tts_failed' && e.httpStatus === 403 && /Unpurchased/.test(e.detail) && e.status === 502);
  const bad = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fakeFetch(() => ({ status: 400, json: { code: 'InvalidParameter' } })).fn, log: quiet });
  await assert.rejects(bad.synthesize('你好'), (e) => e.code === 'tts_failed');
  const empty = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fakeFetch(() => ({ json: { output: {} } })).fn, log: quiet });
  await assert.rejects(empty.synthesize('你好'), (e) => e.code === 'tts_failed');
  const gone = createVoice({ env: { DASHSCOPE_API_KEY: KEY }, fetchImpl: fakeFetch((c) => (c.method === 'POST' ? { json: { output: { audio: { url: 'https://x.test/a.wav' } } } } : { status: 403, bytes: Buffer.from('') })).fn, log: quiet });
  await assert.rejects(gone.synthesize('你好'), (e) => e.code === 'tts_failed');
  assert.equal(audioMime('audio/webm;codecs=opus'), 'audio/webm');
  assert.equal(audioMime('text/plain'), null);
});

test('teacher lines get audio ids; the engine result itself is not changed; failures are caught', async () => {
  const said = [];
  const voice = { configured: true, async synthesize(text) { said.push(text); if (text === 'boom') throw new Error('tts down'); return { audio: WAV, mime: 'audio/wav' }; } };
  const store = new SpeechStore(voice, { log: quiet });
  const result = { say: [{ lang: 'en', text: 'Say it: 硬膜外' }, { lang: 'zh', text: 'boom' }, { lang: 'en', text: '' }], listen: 'zh-CN' };
  const out = store.attach(result);
  assert.equal(result.say[0].audio, undefined, 'the engine result is not mutated');
  assert.ok(out.say[0].audio && out.say[1].audio && out.say[0].audio !== out.say[1].audio);
  assert.equal(out.say[2].audio, undefined, 'blank lines are not synthesised');
  assert.equal(out.listen, 'zh-CN');
  assert.deepEqual(said, ['Say it: 硬膜外', 'boom']);
  assert.deepEqual((await store.get(out.say[0].audio)).audio, WAV);
  await assert.rejects(store.get(out.say[1].audio), /tts down/);
  assert.equal(store.get('nope'), null);
  assert.equal(new SpeechStore({ configured: false }).attach(result), result, 'no Qwen key: text only');
});

// ---------- the whole path through the real server ----------

// A stand-in for Qwen: the teacher (chat), ASR (chat with audio) and TTS.
async function startFakeQwen() {
  const seen = { teacher: [], asr: [], tts: [], downloads: 0, auth: new Set() };
  const control = { asrStatus: 200, asrText: '硬膜外', ttsStatus: 200 };
  const decision = (over) => JSON.stringify({
    intent: 'answer', understood: true, correct: null, needs_retry: false, exercise_complete: false,
    next_action: 'same_exercise', student_confidence: 'ok', jump_target: null, roleplay_role: null,
    speech: [{ lang: 'en', text: 'The first word is 硬膜外, yìng mó wài. Say it.', show: null, slow: false }, { lang: 'zh', text: '硬膜外', show: null, slow: true }],
    notes: '', ...over,
  });
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.headers.authorization) seen.auth.add(req.headers.authorization);
    const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/teacher/chat/completions') {
      const body = JSON.parse(raw);
      seen.teacher.push(body);
      const context = body.messages.at(-1).content;
      const content = /student_turn/.test(context)
        ? decision({ correct: true, exercise_complete: true, next_action: 'next_exercise', speech: [{ lang: 'en', text: 'Good. What does 硬膜外 mean?', show: null, slow: false }] })
        : decision();
      return json(200, { id: 'chat-1', object: 'chat.completion', created: 1, model: body.model, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    }
    if (req.url === '/asr/chat/completions') {
      const body = JSON.parse(raw);
      seen.asr.push(body);
      if (control.asrStatus !== 200) return json(control.asrStatus, { error: { message: 'upstream exploded' } });
      return json(200, { choices: [{ message: { role: 'assistant', content: control.asrText, annotations: [{ type: 'audio_info', language: 'zh' }] } }] });
    }
    // qwen-audio-*-asr: DashScope native endpoint on the (workspace) host.
    if (req.url === '/api/v1/services/aigc/multimodal-generation/generation') {
      const body = JSON.parse(raw);
      seen.asr.push(body);
      if (control.asrStatus !== 200) return json(control.asrStatus, { code: 'InternalError', message: 'upstream exploded' });
      return json(200, { request_id: 'asr-1', output: { text: control.asrText }, usage: { seconds: 1 } });
    }
    if (req.url === '/tts') {
      const body = JSON.parse(raw);
      seen.tts.push(body);
      if (control.ttsStatus !== 200) return json(control.ttsStatus, { code: 'Throttling' });
      return json(200, { output: { finish_reason: 'stop', audio: { url: `http://localhost:${server.address().port}/files/${seen.tts.length}.wav`, data: '' } } });
    }
    if (req.url.startsWith('/files/')) {
      seen.downloads += 1;
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(WAV);
    }
    json(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, seen, control, close: () => new Promise((r) => server.close(r)) };
}

async function startTutor(qwenPort, extraEnv = {}) {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roy-audio-'));
  const base = `http://localhost:${qwenPort}`;
  const env = {
    ...cleanEnv(), TUTOR_ENV_FILE: 'none', PORT: String(port), HOST: '127.0.0.1', TUTOR_DB: path.join(dir, 'tutor.db'),
    DASHSCOPE_API_KEY: KEY, QWEN_BASE_URL: `${base}/teacher`, QWEN_MODEL: 'qwen-test',
    QWEN_ASR_BASE_URL: `${base}/asr`, QWEN_TTS_URL: `${base}/tts`, ...extraEnv,
  };
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], { cwd: appDir, env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start:\n${output}`)), 15000);
    const onData = (d) => { output += d; if (output.includes('Roy Medical Chinese tutor on')) { clearTimeout(timer); resolve(); } };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => reject(new Error(`server exited ${code}:\n${output}`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const url = `http://localhost:${port}`;
  return { url, output: () => output, stop: () => { child.kill(); return exited; } };
}

const postJson = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

test('end to end: recording → Qwen ASR → tutor engine → Qwen TTS audio, key never leaves the server', async () => {
  const qwen = await startFakeQwen();
  const s = await startTutor(qwen.port);
  const everything = [];
  try {
    // Session start: teacher text plus an audio id per line.
    const start = await postJson(`${s.url}/api/session/start`);
    assert.equal(start.status, 200);
    const startBody = await start.text();
    everything.push(startBody);
    const view = JSON.parse(startBody);
    assert.equal(view.exercise, 'pronounce');
    assert.equal(view.listen, 'zh-CN');
    assert.equal(view.status.position, 1);
    assert.ok(view.say.length >= 2 && view.say.every((l) => /^[a-z0-9]+$/.test(l.audio)), 'every line has an audio id');

    // Teacher audio: Qwen TTS bytes relayed by our server.
    const audio = await fetch(`${s.url}/api/voice/speech/${view.say[0].audio}`);
    assert.equal(audio.status, 200);
    assert.equal(audio.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await audio.arrayBuffer()), WAV);
    assert.ok(qwen.seen.tts.some((b) => b.input.text.includes('硬膜外') && b.input.language_type === 'Chinese' && b.model === 'qwen3-tts-instruct-flash' && /普通话/.test(b.input.instructions)));
    assert.ok(qwen.seen.downloads >= 1);

    // Roy's recording goes up; Qwen ASR returns the transcript.
    const up = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
    assert.equal(up.status, 200);
    const heard = await up.json();
    everything.push(JSON.stringify(heard));
    assert.equal(heard.text, '硬膜外');
    assert.equal(heard.language, 'zh-CN');
    const asrCall = qwen.seen.asr.at(-1);
    assert.equal(asrCall.model, 'qwen-audio-3.1-asr-flash');
    assert.deepEqual(asrCall.parameters.language_hints, ['zh']);
    assert.match(asrCall.input.messages[0].content[0].text, /当前术语：硬膜外/, 'the current lesson term is sent as context');
    assert.equal(asrCall.input.messages.at(-1).content[0].input_audio.data, `data:audio/wav;base64,${WAV.toString('base64')}`);

    // The transcript goes to the engine like a typed answer; the lesson moves on.
    const turn = await postJson(`${s.url}/api/session/message`, { text: heard.text, source: 'voice', language: heard.language });
    assert.equal(turn.status, 200);
    const turnBody = await turn.text();
    everything.push(turnBody);
    const next = JSON.parse(turnBody);
    assert.equal(next.exercise, 'meaning', 'pronounce completed, on to meaning');
    assert.equal(next.listen, 'en-US');
    const ctx = qwen.seen.teacher.at(-1).messages.at(-1).content;
    assert.match(ctx, /硬膜外/);
    assert.match(ctx, /"source":\s*"voice"|voice/);

    // English exercise: the upload asks Qwen for English.
    qwen.control.asrText = 'an injection into the spine';
    await fetch(`${s.url}/api/voice/transcribe?lang=en-US`, { method: 'POST', headers: { 'Content-Type': 'audio/mp4' }, body: WAV });
    assert.deepEqual(qwen.seen.asr.at(-1).parameters.language_hints, ['en']);
    assert.match(qwen.seen.asr.at(-1).input.messages[0].content[0].text, /硬膜外/, 'context even when the card hides a field');

    // The key: only ever in the Authorization header to Qwen.
    assert.deepEqual([...qwen.seen.auth], [`Bearer ${KEY}`]);
    const status = await (await fetch(`${s.url}/api/status`)).text();
    everything.push(status);
    assert.match(status, /qwen-audio-3\.1-asr-flash/);
    for (const page of ['/', '/app.js', '/voice-core.js']) everything.push(await (await fetch(`${s.url}${page}`)).text());
    for (const text of everything) assert.ok(!text.includes(KEY) && !/DASHSCOPE_API_KEY=|Authorization|Bearer/.test(text), 'no key in anything the browser receives');
    assert.ok(!s.output().includes(KEY), 'the key is not printed');
    assert.match(s.output(), /speech recognition: Qwen qwen-audio-3\.1-asr-flash \(QWEN_ASR_MODEL from default\), native DashScope API at http:\/\/localhost:\d+\/api\/v1\/services\/aigc\/multimodal-generation\/generation/);
    assert.match(s.output(), /teacher voice: Qwen qwen3-tts-instruct-flash/);
  } finally {
    await s.stop();
    await qwen.close();
  }
});

test('ASR failure: clear error, nothing reaches the engine, and a retry of the same recording works', async () => {
  const qwen = await startFakeQwen();
  const s = await startTutor(qwen.port);
  try {
    await postJson(`${s.url}/api/session/start`);
    const teacherCalls = qwen.seen.teacher.length;
    qwen.control.asrStatus = 500;
    const failed = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
    assert.equal(failed.status, 502);
    const err = await failed.json();
    assert.equal(err.code, 'asr_failed');
    assert.doesNotMatch(JSON.stringify(err), /upstream exploded/, "Qwen's own error text is not passed on");
    assert.equal(qwen.seen.teacher.length, teacherCalls, 'the teacher was not asked anything');
    const st = await (await fetch(`${s.url}/api/status`)).json();
    assert.equal(st.session.exercise, 'pronounce');
    assert.equal(st.position, 1);

    qwen.control.asrStatus = 200;
    const retry = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).text, '硬膜外');

    qwen.control.asrText = '';
    const empty = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
    assert.equal(empty.status, 422);
    assert.equal((await empty.json()).code, 'asr_empty');

    const wrongType = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    assert.equal(wrongType.status, 415);
    const huge = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: Buffer.alloc(8 * 1024 * 1024) });
    assert.equal(huge.status, 413);
  } finally {
    await s.stop();
    await qwen.close();
  }
});

test('TTS failure: the teacher text still arrives and the lesson continues', async () => {
  const qwen = await startFakeQwen();
  qwen.control.ttsStatus = 429;
  const s = await startTutor(qwen.port);
  try {
    const start = await (await postJson(`${s.url}/api/session/start`)).json();
    assert.ok(start.say[0].text.includes('硬膜外'), 'the text is there to read');
    const audio = await fetch(`${s.url}/api/voice/speech/${start.say[0].audio}`);
    assert.equal(audio.status, 502);
    assert.equal((await audio.json()).code, 'tts_failed');
    const turn = await (await postJson(`${s.url}/api/session/message`, { text: '硬膜外', source: 'voice', language: 'zh-CN' })).json();
    assert.equal(turn.exercise, 'meaning', 'the lesson carried on');
    assert.equal((await fetch(`${s.url}/api/voice/speech/zzzz`)).status, 404, 'unknown audio ids are refused');
  } finally {
    await s.stop();
    await qwen.close();
  }
});

test('access code applies to the voice routes too', async () => {
  const qwen = await startFakeQwen();
  const s = await startTutor(qwen.port, { TUTOR_ACCESS_CODE: 'letmein' });
  try {
    const blocked = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: WAV });
    assert.equal(blocked.status, 401);
    assert.equal(qwen.seen.asr.length, 0, 'nothing was sent to Qwen');
    const ok = await fetch(`${s.url}/api/voice/transcribe?lang=zh-CN`, { method: 'POST', headers: { 'Content-Type': 'audio/wav', 'X-Access-Code': 'letmein' }, body: WAV });
    assert.equal(ok.status, 200);
  } finally {
    await s.stop();
    await qwen.close();
  }
});

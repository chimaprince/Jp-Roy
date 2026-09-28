// Real Qwen voice check, from the same Node and .env the server uses.
//   npm run check-voice                 (optionally: -- my-recording.wav)
// 1. Qwen TTS (qwen3-tts-instruct-flash) speaks a JH Medics line; the audio
//    is checked for a format browsers play and saved to voice-check.wav so
//    you can listen to it.
// 2. That audio (or the WAV file you pass) goes to Qwen ASR
//    (qwen-audio-3.1-asr-flash), which should hear the Mandarin back. If TTS failed
//    and no file is given, ASR gets a short silent clip, which checks that
//    ASR answers and accepts the key.
// No microphone or browser needed. Never prints the API key.
import { envFile, envProblems, envNotices, envSource } from '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoice, audioInfo, asrEndpointProblem, asrContext } from '../src/voice.js';
import { encodeWav } from '../public/voice-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'voice-check.wav');
const voice = createVoice();
const LINE = '硬膜外。医生说：我们需要打硬膜外。';

console.log(`ASR model: ${voice.asrModel}`);
console.log(`ASR protocol: ${voice.asrProtocol === 'native' ? 'native DashScope' : 'OpenAI-compatible (qwen3-asr only)'}`);
console.log(`ASR endpoint: ${voice.asrURL}`);
console.log(`QWEN_ASR_MODEL from: ${envSource('QWEN_ASR_MODEL')}${envFile ? ` (env file: ${envFile})` : ' (no .env file found)'}`);
envProblems.forEach((p) => console.error(`!!  ${p}`));
envNotices.forEach((n) => console.warn(`note: ${n}`));
console.log(`TTS model:    ${voice.ttsModel}`);
console.log(`TTS endpoint: ${voice.ttsURL}`);
console.log(`TTS voice:    ${voice.ttsVoice}`);
console.log(`TTS style:    ${voice.ttsInstructions}`);
const asrProblem = asrEndpointProblem(voice.asrURL);
if (asrProblem) console.error(`!!  ${asrProblem}`);
if (!voice.configured) {
  console.error('!! DASHSCOPE_API_KEY is missing (roy-tutor/.env).');
  process.exit(1);
}
const report = (err) => `${err.code ?? ''} ${err.message}${err.detail ? `\n     detail: ${err.detail}` : ''}`;
let failures = 0;

// ---- TTS ----
console.log('');
console.log(`TTS: "${LINE}"`);
let ttsAudio = null;
try {
  const t = Date.now();
  const r = await voice.synthesize(LINE);
  console.log(`TTS HTTP status: ${r.status}`);
  console.log(`OK  TTS returned ${r.audio.length} bytes of ${r.mime} in ${Date.now() - t} ms`);
  // Browsers (Safari, Chrome) play PCM WAV and MP3.
  const info = audioInfo(r.audio);
  const playable = info && (info.encoding === 'pcm' || info.encoding === 'mp3') && (info.seconds === null || info.seconds > 0.2);
  if (playable) {
    fs.writeFileSync(out, r.audio);
    console.log(`OK  playable in the browser: ${info.container.toUpperCase()} ${info.encoding}${info.sampleRate ? `, ${info.sampleRate} Hz, ${info.channels} channel(s), ${info.bits}-bit, ${info.seconds.toFixed(1)} s` : ''}`);
    console.log(`    saved to ${out} - open it to listen`);
    ttsAudio = { audio: r.audio, mime: info.container === 'mp3' ? 'audio/mpeg' : 'audio/wav' };
  } else {
    failures += 1;
    console.error(`!!  TTS audio is not in a format browsers play: ${info ? JSON.stringify(info) : 'not WAV or MP3'}`);
  }
} catch (err) {
  failures += 1;
  console.error(`TTS HTTP status: ${err.httpStatus ?? 'no reply from Qwen'}`);
  console.error(`!!  TTS failed: ${report(err)}`);
}

// ---- ASR ----
console.log('');
const file = process.argv[2];
let sample;
if (file) sample = { audio: fs.readFileSync(file), mime: 'audio/wav', what: file, expect: null };
else if (ttsAudio) sample = { ...ttsAudio, what: 'the TTS audio above', expect: '硬膜外' };
else sample = { audio: Buffer.from(encodeWav(new Float32Array(16000), 16000)), mime: 'audio/wav', what: '1 s of silence (TTS failed)', expect: null, silent: true };
console.log(`ASR input: ${sample.what}`);
// The same context the tutor sends on Word 1 (epidural).
const entry = { mandarin: '硬膜外', pinyin: 'yìng mó wài', english: 'epidural' };
console.log(`ASR context: ${asrContext(entry)}`);
try {
  const t = Date.now();
  const r = await voice.transcribe(sample.audio, sample.mime, 'zh-CN', { entry });
  console.log(`ASR HTTP status: ${r.status}`);
  console.log(`ASR request: ${r.request}`);
  console.log(`ASR transcript: ${r.text}`);
  const ok = !sample.expect || r.text.includes(sample.expect);
  if (!ok) failures += 1;
  console.log(`${ok ? 'OK' : '!!'}  ASR returned a transcript in ${Date.now() - t} ms${ok ? '' : ` (expected ${sample.expect} in it)`}`);
} catch (err) {
  console.error(`ASR HTTP status: ${err.httpStatus ?? 'no reply from Qwen'}`);
  console.error('ASR transcript: (none)');
  if (sample.silent && err.code === 'asr_empty') {
    console.log('OK  ASR answered and accepted the key (no words in silence, as expected)');
  } else {
    failures += 1;
    console.error(`!!  ASR failed: ${report(err)}`);
  }
}

console.log('');
console.log(`Summary: ASR ${voice.asrModel}, TTS ${voice.ttsModel}`);
console.log(failures ? `${failures} check(s) failed.` : 'All voice checks passed.');
process.exit(failures ? 1 : 0);

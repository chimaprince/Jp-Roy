// Real Qwen voice check, from the same Node and .env the server uses.
//   npm run check-voice
// 1. Qwen TTS (qwen3-tts-flash) speaks a JH Medics line; the audio is saved
//    to voice-check.wav so you can listen to it.
// 2. That audio goes to Qwen ASR (qwen3-asr-flash), which should hear the
//    Mandarin back.
// No microphone or browser needed. Never prints the API key.
import '../src/env.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVoice } from '../src/voice.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'voice-check.wav');
const voice = createVoice();

console.log(`TTS: ${voice.ttsModel}, voice ${voice.ttsVoice}, ${voice.ttsURL}`);
console.log(`ASR: ${voice.asrModel}, ${voice.asrBaseURL}`);
if (!voice.configured) {
  console.error('!! DASHSCOPE_API_KEY is missing (roy-tutor/.env).');
  process.exit(1);
}
const report = (err) => `${err.code ?? ''} ${err.message}${err.detail ? `\n     detail: ${err.detail}` : ''}`;

let audio;
try {
  const t = Date.now();
  const r = await voice.synthesize('硬膜外。医生说：我们需要打硬膜外。');
  audio = r.audio;
  fs.writeFileSync(out, audio);
  console.log(`OK  TTS: ${audio.length} bytes of ${r.mime} in ${Date.now() - t} ms, saved to ${out}`);
} catch (err) {
  console.error(`!!  TTS failed: ${report(err)}`);
  process.exit(1);
}
try {
  const t = Date.now();
  const r = await voice.transcribe(audio, 'audio/wav', 'zh-CN');
  const ok = r.text.includes('硬膜外');
  console.log(`${ok ? 'OK' : '??'}  ASR heard: "${r.text}" in ${Date.now() - t} ms${ok ? '' : ' (expected 硬膜外 in it)'}`);
} catch (err) {
  console.error(`!!  ASR failed: ${report(err)}`);
  process.exit(1);
}

// Loads settings from a .env file at startup, before anything reads them
// (this does what the dotenv package does, using Node's built-in parser).
// Looks in roy-tutor/.env first, then in the repository root.
//
// The .env file is the source of truth: a value in .env replaces the same
// variable inherited from the shell or the Windows environment, and the
// startup log says so. (Before, a stale shell variable such as
// QWEN_ASR_MODEL=qwen3-asr-flash silently won over .env.) Duplicate lines and
// a second, ignored .env file are reported too. Secret values are never logged.
//
// TUTOR_ENV_FILE=<path> loads that file instead; TUTOR_ENV_FILE=none loads no
// file (the tests use this so a developer's real .env never leaks into them).
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_CANDIDATES = [path.join(appDir, '.env'), path.join(appDir, '..', '.env')];

// Values of these are never printed.
const SECRET = /KEY|SECRET|TOKEN|PASSWORD|CODE/i;
const show = (key, value) => (SECRET.test(key) ? '(value hidden)' : `"${value}"`);

// Windows Notepad can save "Unicode" (UTF-16) files or add a byte-order mark;
// either would hide the first variable name from the parser.
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

// Keys defined more than once in the file (the parser keeps the last one).
function duplicateKeys(text) {
  const seen = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m) seen.set(m[1], (seen.get(m[1]) ?? 0) + 1);
  }
  return [...seen].filter(([, n]) => n > 1).map(([k]) => k);
}

// Reads the .env file into `env`. Returns what happened, for the startup log.
export function loadEnv({ env = process.env, candidates = DEFAULT_CANDIDATES } = {}) {
  const result = { file: null, keysFromFile: [], sources: {}, problems: [], notices: [] };
  const choice = env.TUTOR_ENV_FILE;
  if (choice === 'none') return result;
  const list = choice ? [path.resolve(choice)] : candidates;
  const file = list.find((f) => fs.existsSync(f)) ?? null;
  if (!file) {
    // Windows Explorer hides extensions, so ".env" is often saved as ".env.txt".
    for (const f of list) {
      if (fs.existsSync(`${f}.txt`)) result.problems.push(`found ${f}.txt - rename it to .env (no .txt)`);
    }
    if (choice) result.problems.push(`TUTOR_ENV_FILE points to ${choice}, which does not exist`);
    return result;
  }
  result.file = file;
  const text = readText(file);
  const parsed = parseEnv(text);
  for (const key of duplicateKeys(text)) {
    result.problems.push(`${key} appears more than once in ${file}; the LAST line is used (${show(key, parsed[key])}). Delete the extra lines.`);
  }
  for (const f of list) {
    if (f !== file && fs.existsSync(f)) result.notices.push(`${f} also exists but is NOT loaded (only ${file} is). Keep one .env file.`);
  }
  for (const [key, value] of Object.entries(parsed)) {
    const inherited = env[key];
    if (inherited !== undefined && inherited !== value) {
      result.notices.push(`${key}: using ${show(key, value)} from ${path.basename(file)}, not ${show(key, inherited)} from the shell/system environment.`);
    }
    env[key] = value;
    result.keysFromFile.push(key);
    result.sources[key] = '.env';
  }
  for (const key of Object.keys(env)) result.sources[key] ??= 'environment';
  return result;
}

const loaded = loadEnv();
export const envFile = loaded.file;
export const envKeysFromFile = loaded.keysFromFile;
export const envProblems = loaded.problems;
export const envNotices = loaded.notices;

// Where a setting came from: '.env', 'environment' (shell/system), or 'default'.
export function envSource(key) {
  return loaded.sources[key] ?? (process.env[key] !== undefined ? 'environment' : 'default');
}

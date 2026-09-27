// Loads settings from a .env file at startup, before anything reads them
// (this does what the dotenv package does, using Node's built-in parser).
// Looks in roy-tutor/.env first, then in the repository root. Variables already
// set in the shell win over the file. Values are never logged.
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const appDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [path.join(appDir, '.env'), path.join(appDir, '..', '.env')];

export const envFile = candidates.find((f) => fs.existsSync(f)) ?? null;
export const envKeysFromFile = [];
export const envProblems = [];

// Windows Notepad can save "Unicode" (UTF-16) files or add a byte-order mark;
// either would hide the first variable name from the parser.
function readText(file) {
  const buf = fs.readFileSync(file);
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

if (envFile) {
  const parsed = parseEnv(readText(envFile));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      envKeysFromFile.push(key);
    }
  }
} else {
  // Windows Explorer hides extensions, so ".env" is often saved as ".env.txt".
  for (const f of candidates) {
    if (fs.existsSync(`${f}.txt`)) envProblems.push(`found ${f}.txt - rename it to .env (no .txt)`);
  }
}

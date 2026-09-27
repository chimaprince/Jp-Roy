// Loads settings from a .env file at startup, before anything reads them.
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

if (envFile) {
  const parsed = parseEnv(fs.readFileSync(envFile, 'utf8'));
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      envKeysFromFile.push(key);
    }
  }
}

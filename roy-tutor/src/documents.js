// Turns a course document into curriculum entries, the same way for every
// document: JH Medics Volume 1, Volume 2, or any other medical Chinese course.
// The teaching itself is never per-document (see listencontent.js, teacher.js):
// a document only supplies WHAT is learnt, in its own order.
//
// Supported: .docx (tables: one item per row; or one item per paragraph),
// .txt (one item per line), .csv / .tsv, .json ({ entries: [...] }).
// A .pdf cannot be read reliably without extra software: open it in Word,
// save it as .docx, and add that.
//
// What happens to the text, and nothing more (as for JH Medics Volume 1):
//   - English and meaning: outer spaces trimmed, a line break becomes a space.
//   - A cell or line holding Chinese and Latin letters is split mechanically
//     into the Chinese part (mandarin) and the pinyin part, in source order;
//     several parts are joined with " / ".
//   - Nothing is translated, re-toned, corrected or invented. A missing pinyin,
//     English or meaning stays missing (the report lists it).
//   - Every raw row is kept under `source`, so each entry can be checked.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { parseCsv } from './curriculum.js';

const HAN = '\\u3400-\\u9fff\\uf900-\\ufaff';
const CJK_PUNCT = '\\u3000-\\u303f\\uff00-\\uff0f\\uff1a-\\uff20\\uff3b-\\uff40\\uff5b-\\uff65';
const HAN_RE = new RegExp(`[${HAN}]`, 'u');
const HAN_G = new RegExp(`[${HAN}]`, 'gu');
const CJK_PUNCT_RE = new RegExp(`[${CJK_PUNCT}]`, 'u');
const HAN_JOINERS = new Set([' ', '\t', '\n', '/', '-', ',', ';', ':', '(', ')']);
const TONE_MARKS = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;

// ---------- .docx (a zip of XML files), read with Node only ----------

function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a .docx file (no zip directory found)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('damaged .docx (zip directory)');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files.set(name, () => (method === 8 ? zlib.inflateRawSync(raw) : raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&amp;/g, '&');

// Text of a paragraph's runs: <w:t>, tabs and line breaks.
function paragraphText(xml) {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\s*\/>|<w:(tab|br|cr)\b[^>]*\/>/g)) {
    if (m[2] === 'tab') out += '\t';
    else if (m[2]) out += '\n';
    else out += unxml(m[1] ?? '');
  }
  return out;
}

const paragraphs = (xml) => [...xml.matchAll(/<w:p\b[^>]*?(?:\/>|>([\s\S]*?)<\/w:p>)/g)].map((m) => paragraphText(m[1] ?? ''));

// { tables: [rows: [cells: text]], paragraphs: [text] } (paragraphs outside tables)
export function readDocx(buf) {
  const files = unzip(buf);
  const doc = files.get('word/document.xml');
  if (!doc) throw new Error('not a Word document (word/document.xml missing)');
  const xml = doc().toString('utf8');
  const tables = [];
  const outside = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/g)].map((r) => [...r[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/g)].map((c) => paragraphs(c[1]).join('\n')));
    tables.push(rows);
    return '';
  });
  return { tables, paragraphs: paragraphs(outside) };
}

// ---------- splitting text into Chinese and pinyin (as for JH Medics) ----------

// Splits a cell holding Chinese and pinyin into (chinese parts, pinyin parts).
export function splitMandarin(cell) {
  const parts = [];
  let cur = '';
  let kind = null;
  const chars = [...cell];
  const isLetter = (c) => /\p{L}/u.test(c);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    let k;
    if (HAN_RE.test(ch) || CJK_PUNCT_RE.test(ch)) k = 'zh';
    else if (/[A-Za-z]/.test(ch) && i + 1 < chars.length && (HAN_RE.test(chars[i + 1]) || (chars[i + 1] === '-' && i + 2 < chars.length && HAN_RE.test(chars[i + 2])))) k = 'zh'; // x光, x-射线
    else if (isLetter(ch) || ch === '(' || ch === ')') k = 'py';
    else if (kind === 'zh' && HAN_JOINERS.has(ch)) {
      const rest = chars.slice(i).join('');
      const m = rest.match(new RegExp(`[${HAN}]|[^\\W\\d_]`, 'u'));
      k = m && HAN_RE.test(m[0]) ? 'zh' : 'gap';
    } else if (kind === 'py') k = 'py';
    else k = 'gap';
    if (k !== kind) {
      if (cur && (kind === 'zh' || kind === 'py')) parts.push([kind, cur]);
      cur = '';
      kind = k;
    }
    cur += ch;
  }
  if (cur && (kind === 'zh' || kind === 'py')) parts.push([kind, cur]);
  const clean = (s) => s.replace(/[ \t]*\n[ \t\n]*/g, ' / ').replace(/^[ \t\n/,;-]+|[ \t\n/,;-]+$/g, '');
  const zh = parts.filter(([k]) => k === 'zh').map(([, s]) => clean(s)).filter(Boolean);
  const py = parts.filter(([k]) => k === 'py').map(([, s]) => clean(s)).filter(Boolean);
  return { mandarin: zh.join(' / '), pinyin: py.join(' / ') };
}

const tidy = (s) => String(s ?? '').replace(/[ \t]*\n[ \t\n]*/g, ' ').trim();
const hanShare = (s) => { const t = String(s ?? '').replace(/\s/g, ''); return t ? (t.match(HAN_G)?.length ?? 0) / [...t].length : 0; };
const looksPinyin = (s) => TONE_MARKS.test(s) && !HAN_RE.test(s);

// ---------- rows (a table, a CSV/TSV) → entries ----------

const HEADER = {
  english: /^(english|en|translation|term \(english\)|英文|英语)$/i,
  mandarin: /^(mandarin|chinese|zh|term|中文|汉语|普通话|词语)$/i,
  pinyin: /^(pinyin|拼音)$/i,
  meaning: /^(meaning|definition|description|explanation|notes?|含义|解释|意思)$/i,
};

// Which column holds what: a header row if it names the columns, otherwise
// from the content (the column with Chinese is the item; tone-marked Latin is
// pinyin; of the English columns, the shorter one is the English, the longer
// one the meaning).
function columnRoles(rows) {
  const width = Math.max(...rows.map((r) => r.length));
  const head = rows[0].map((c) => tidy(c));
  const named = {};
  head.forEach((h, i) => { for (const [role, re] of Object.entries(HEADER)) if (re.test(h) && named[role] === undefined) named[role] = i; });
  if (named.mandarin !== undefined) return { roles: named, body: rows.slice(1) };
  const body = rows;
  const stats = Array.from({ length: width }, (_, i) => {
    const cells = body.map((r) => String(r[i] ?? '')).filter((c) => c.trim());
    return {
      i,
      han: cells.length ? cells.reduce((a, c) => a + hanShare(c), 0) / cells.length : 0,
      pinyin: cells.length ? cells.filter(looksPinyin).length / cells.length : 0,
      length: cells.length ? cells.reduce((a, c) => a + c.length, 0) / cells.length : 0,
      filled: cells.length / Math.max(1, body.length),
    };
  });
  const roles = {};
  const zh = [...stats].sort((a, b) => b.han - a.han)[0];
  if (zh && zh.han > 0.2) roles.mandarin = zh.i;
  const rest = stats.filter((s) => s.i !== roles.mandarin && s.filled > 0.2);
  const py = rest.filter((s) => s.pinyin > 0.5).sort((a, b) => b.pinyin - a.pinyin)[0];
  if (py) roles.pinyin = py.i;
  const latin = rest.filter((s) => s.i !== roles.pinyin && s.han < 0.2).sort((a, b) => a.i - b.i);
  if (latin.length === 1) roles.english = latin[0].i;
  else if (latin.length >= 2) {
    const [shorter, longer] = [...latin].sort((a, b) => a.length - b.length);
    roles.english = shorter.i;
    roles.meaning = longer.i;
  }
  // A first row that is clearly a header (no Chinese where the items are) is skipped.
  const first = rows[0];
  const isHeader = roles.mandarin !== undefined && !HAN_RE.test(String(first[roles.mandarin] ?? '')) && rows.length > 1;
  return { roles, body: isHeader ? rows.slice(1) : rows };
}

export function entriesFromRows(rows) {
  const clean = rows.filter((r) => r.some((c) => String(c ?? '').trim()));
  if (!clean.length) return [];
  const { roles, body } = columnRoles(clean);
  if (roles.mandarin === undefined) throw new Error('could not find a column with Chinese in the document');
  return body.map((r, n) => {
    const cell = (role) => (roles[role] === undefined ? '' : String(r[roles[role]] ?? ''));
    const split = splitMandarin(cell('mandarin'));
    const pinyin = roles.pinyin !== undefined ? tidy(cell('pinyin')) : split.pinyin;
    return {
      position: n + 1,
      english: tidy(cell('english')),
      mandarin: split.mandarin,
      pinyin,
      meaning: tidy(cell('meaning')) || null,
      source_page: null,
      source: { row: n + 1, cells: r },
    };
  }).filter((e) => e.mandarin);
}

// ---------- lines of text → entries ----------

// One item per line: "硬膜外 yìng mó wài epidural", "硬膜外 | yìng mó wài | epidural",
// "硬膜外 (yìng mó wài) - epidural: an injection …".
export function entriesFromLines(lines) {
  const rows = [];
  for (const raw of lines) {
    const line = String(raw ?? '').trim();
    if (!line || !HAN_RE.test(line)) continue; // titles and notes without Chinese are not items
    if (/\t| \| /.test(line)) { rows.push(line.split(/\t| \| /).map((c) => c.trim())); continue; }
    // Chinese first, then pinyin (tone-marked syllables), then English / meaning.
    const m = line.match(new RegExp(`^([^A-Za-z]*?[${HAN}][^A-Za-z]*?)(?=[A-Za-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü(]|$)(.*)$`, 'u'));
    if (!m) continue;
    const mandarin = m[1].replace(/[\s\-–—:：=]+$/u, '').trim();
    let rest = m[2].trim();
    const words = rest.split(/\s+/);
    // Pinyin: tone-marked syllables; an unmarked one (neutral tone, e.g. "zi")
    // only when a tone-marked syllable follows within three words. Otherwise
    // untoned words are English (they cannot be told apart safely).
    const bare = (w) => w.replace(/[()（）,]/g, '');
    const toned = (w) => TONE_MARKS.test(bare(w)) && /^[a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜü']+$/i.test(bare(w));
    // A real pinyin syllable (initial + final), e.g. "fu", "zi" — not an English word like "fever".
    const syllable = (w) => /^(zh|ch|sh|[bpmfdtnlgkhjqxrzcsyw])?(iang|iong|uang|ang|eng|ing|ong|iao|ian|uai|uan|ai|ei|ao|ou|an|en|in|un|ün|ia|ie|iu|ua|uo|ui|ue|üe|er|a|o|e|i|u|ü)$/.test(bare(w));
    let k = 0;
    // (also when it ends the pinyin: followed by the end of the line or by a
    // capitalised English word, e.g. "shū fu What is …")
    const endsPinyin = (i) => i >= words.length || /^[A-Z]/.test(words[i]);
    while (k < words.length && (toned(words[k]) || (k > 0 && syllable(words[k]) && (words.slice(k + 1, k + 4).some(toned) || endsPinyin(k + 1))))) k++;
    const pinyin = words.slice(0, k).join(' ').replace(/^\(|\)$/g, '');
    rest = words.slice(k).join(' ').replace(/^[\s\-–—:：=)]+/u, '');
    const [english, ...more] = rest.split(/\s*[:：]\s+|\s+[–—-]\s+/);
    rows.push([mandarin, pinyin, english ?? '', more.join(': ')]);
  }
  return rows.map(([mandarin, pinyin, english, meaning], n) => ({
    position: n + 1,
    english: tidy(english),
    ...((() => { const s = splitMandarin(mandarin); return { mandarin: s.mandarin, pinyin: tidy(pinyin) || s.pinyin }; })()),
    meaning: tidy(meaning) || null,
    source_page: null,
    source: { line: n + 1, text: [mandarin, pinyin, english, meaning].filter(Boolean).join(' | ') },
  })).filter((e) => e.mandarin);
}

// ---------- any file → entries ----------

export function readDocument(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') throw new Error('PDF files cannot be read reliably here. Open the PDF in Word, save it as .docx, and add the .docx.');
  if (ext === '.json') {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { entries: (json.entries ?? json).map((e, i) => ({ ...e, position: e.position ?? i + 1 })), from: 'JSON' };
  }
  if (ext === '.csv') return { entries: entriesFromRows(parseCsvRows(fs.readFileSync(file, 'utf8'))), from: 'CSV' };
  if (ext === '.tsv') return { entries: entriesFromRows(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => l.split('\t'))), from: 'TSV' };
  if (ext === '.txt' || ext === '.md') return { entries: entriesFromLines(fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/)), from: 'text' };
  if (ext === '.docx') {
    const doc = readDocx(fs.readFileSync(file));
    const table = doc.tables.sort((a, b) => b.length - a.length)[0];
    if (table && table.length >= 2) return { entries: entriesFromRows(table), from: `Word table (${table.length} rows)` };
    return { entries: entriesFromLines(doc.paragraphs.flatMap((p) => p.split('\n'))), from: 'Word paragraphs' };
  }
  throw new Error(`unsupported file type ${ext || '(none)'}: use .docx, .txt, .csv, .tsv or .json`);
}

// CSV rows as arrays (curriculum.parseCsv returns objects keyed by header).
function parseCsvRows(text) {
  const objs = parseCsv(`${text.split(/\r?\n/)[0].split(',').map((_, i) => `c${i}`).join(',')}\n${text}`);
  return objs.map((o) => Object.values(o));
}

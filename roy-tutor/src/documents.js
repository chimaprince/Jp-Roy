// Turns a course document into curriculum entries, the same way for every
// document: JH Medics Volume 1, Volume 2, or any other medical Chinese course.
// The teaching itself is never per-document (see listencontent.js, teacher.js):
// a document only supplies WHAT is learnt, in its own order.
//
// Supported: .pdf (text PDFs: tables or lines; a scanned, image-only PDF is
// refused with a clear message, never guessed), .docx (tables: one item per
// row; or one item per paragraph), .txt (one item per line), .csv / .tsv,
// .json ({ entries: [...] }).
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

// ---------- .pdf (text PDFs; a scanned PDF is refused, never guessed) ----------

const appDir = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');

// Text items with their positions → rows of cells (a table) or lines.
// A table is rebuilt the way a reader sees it: columns are where text starts;
// in each column, lines close together form one cell (a wrapped cell); cells
// in different columns whose heights overlap form one row. This works whether
// the cells are top-aligned or centred.
// Text runs with exact positions, read from the page's drawing operations (one
// run per text-drawing call, split where a run jumps more than a character).
// pdf.js's own text content merges neighbouring table cells drawn on the same
// line, so it cannot be used to tell columns apart.
function textRuns(list, OPS) {
  const runs = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let size = 10;
  let charSpacing = 0;
  let wordSpacing = 0;
  let hScale = 1;
  let leading = 0;
  let font = null;
  const at = () => { const m = mul(ctm, tm); return { x: m[4], y: m[5], scale: Math.hypot(m[2], m[3]) || 1 }; };
  list.fnArray.forEach((fn, i) => {
    const a = list.argsArray[i];
    if (fn === OPS.save) stack.push({ ctm, size, charSpacing, wordSpacing, hScale, leading, font });
    else if (fn === OPS.restore) { const st = stack.pop(); if (st) ({ ctm, size, charSpacing, wordSpacing, hScale, leading, font } = st); }
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.beginText) { tm = [1, 0, 0, 1, 0, 0]; tlm = tm; }
    else if (fn === OPS.setFont) { size = a[1]; font = a[0]; }
    else if (fn === OPS.setCharSpacing) charSpacing = a[0];
    else if (fn === OPS.setWordSpacing) wordSpacing = a[0];
    else if (fn === OPS.setHScale) hScale = a[0] / 100;
    else if (fn === OPS.setLeading) leading = a[0];
    else if (fn === OPS.setTextMatrix) { tm = [...a]; tlm = tm; }
    else if (fn === OPS.moveText || fn === OPS.setLeadingMoveText) { if (fn === OPS.setLeadingMoveText) leading = -a[1]; tlm = mul(tlm, [1, 0, 0, 1, a[0], a[1]]); tm = tlm; }
    else if (fn === OPS.nextLine) { tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; }
    else if (fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      if (fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) { tlm = mul(tlm, [1, 0, 0, 1, 0, -leading]); tm = tlm; }
      const glyphs = a[0];
      let run = null;
      const start = () => { const p = at(); run = { str: '', x: p.x, y: p.y, size: size * p.scale, end: p.x, page: 0 }; runs.push(run); };
      const advance = (tx) => { tm = mul(tm, [1, 0, 0, 1, tx, 0]); };
      for (const g of glyphs) {
        if (typeof g === 'number') {
          const tx = (-g / 1000) * size * hScale;
          if (Math.abs(tx) > size * 1.0) run = null; // a jump: the next glyphs are a new run
          advance(tx);
          continue;
        }
        if (!g) continue;
        if (!run) start();
        const w = ((g.width ?? 0) / 1000) * size;
        const tx = (w + charSpacing + (g.isSpace ? wordSpacing : 0)) * hScale;
        run.str += g.unicode ?? '';
        advance(tx);
        run.end = at().x;
      }
    }
  });
  return runs
    .filter((r) => r.str.trim())
    .map((r) => ({ str: r.str, width: Math.abs(r.end - r.x), transform: [r.size, 0, 0, r.size, Math.min(r.x, r.end), r.y] }));
}

// The horizontal lines a table is drawn with (its row borders), per page, as
// y positions. Thin filled rectangles and straight line segments both count.
function horizontalRules(list, OPS) {
  const ys = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  const pt = (x, y) => [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]];
  list.fnArray.forEach((fn, i) => {
    const args = list.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.constructPath) {
      const [ops, coords] = args;
      let k = 0;
      let last = null;
      for (const op of ops) {
        if (op === OPS.rectangle) {
          const [x, y, w, h] = coords.slice(k, k + 4);
          k += 4;
          const a = pt(x, y);
          const b = pt(x + w, y + h);
          if (Math.abs(a[1] - b[1]) <= 3 && Math.abs(a[0] - b[0]) >= 20) ys.push((a[1] + b[1]) / 2);
        } else if (op === OPS.moveTo) { last = pt(coords[k], coords[k + 1]); k += 2; } else if (op === OPS.lineTo) {
          const p2 = pt(coords[k], coords[k + 1]);
          k += 2;
          if (last && Math.abs(last[1] - p2[1]) <= 1 && Math.abs(last[0] - p2[0]) >= 20) ys.push(last[1]);
          last = p2;
        } else if (op === OPS.curveTo) k += 6;
        else if (op === OPS.curveTo2 || op === OPS.curveTo3) k += 4;
      }
    }
  });
  const sorted = ys.sort((a, b) => b - a);
  return sorted.filter((y, i) => i === 0 || sorted[i - 1] - y > 2);
}

function pdfRows(items, rules = {}) {
  const parts = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    parts.push({ page: it.page, x: it.transform[4], y: it.transform[5], end: it.transform[4] + it.width, size: Math.abs(it.transform[3]) || 10, text: it.str });
  }
  // Columns: left edges shared by many pieces of text.
  const clusters = [];
  for (const x of parts.map((f) => f.x).sort((a, b) => a - b)) {
    const c = clusters.at(-1);
    if (c && x - c.max <= 4) { c.max = x; c.n += 1; } else clusters.push({ min: x, max: x, n: 1 });
  }
  const columns = clusters.filter((c) => c.n >= Math.max(3, parts.length * 0.05)).map((c) => c.min);
  const column = (x) => columns.reduce((best, s, i) => (s <= x + 4 ? i : best), 0);
  // Lines; on a line, pieces of the same column join into one fragment (never across a column).
  const lines = [];
  for (const p of parts) {
    let line = lines.find((l) => l.page === p.page && Math.abs(l.y - p.y) <= p.size * 0.4);
    if (!line) { line = { page: p.page, y: p.y, size: p.size, parts: [] }; lines.push(line); }
    line.parts.push(p);
  }
  lines.sort((a, b) => a.page - b.page || b.y - a.y);
  const frags = [];
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    l.cells = [];
    for (const p of l.parts) {
      const last = l.cells.at(-1);
      const col = columns.length ? column(p.x) : 0;
      if (last && last.col === col && p.x - last.end <= l.size * 1.2) { last.text += (p.x - last.end > l.size * 0.15 ? ' ' : '') + p.text; last.end = p.end; } else l.cells.push({ x: p.x, end: p.end, text: p.text, col });
    }
    for (const c of l.cells) frags.push({ ...c, y: l.y, page: l.page, size: l.size });
  }
  if (columns.length < 2 || lines.filter((l) => l.cells.length >= 2).length < 2) return { lines: lines.map((l) => l.cells.map((c) => c.text).join(' ')) };
  // A visual line wrap is not a line break in the document: rejoin with a
  // space (nothing between two Chinese characters).
  const rejoin = (a, b) => (new RegExp(`[${HAN}]$`, 'u').test(a) && new RegExp(`^[${HAN}]`, 'u').test(b) ? `${a}${b}` : `${a} ${b}`);
  // A table drawn with row borders: each row is the band between two borders.
  const ruled = Object.values(rules).some((r) => r.length >= 3);
  if (ruled) {
    const bands = new Map();
    for (const f of frags) {
      const r = rules[f.page] ?? [];
      if (r.length < 2 || f.y > r[0] || f.y < r.at(-1)) continue; // outside the table (titles, page numbers)
      const band = r.filter((y) => y > f.y).length;
      const key = `${f.page}:${band}`;
      if (!bands.has(key)) bands.set(key, { page: f.page, band, cells: Array(columns.length).fill('') });
      const row = bands.get(key);
      row.cells[f.col] = row.cells[f.col] ? rejoin(row.cells[f.col], f.text) : f.text;
    }
    return { rows: [...bands.values()].sort((a, b) => a.page - b.page || a.band - b.band).map((r) => r.cells) };
  }
  // Cell blocks: per page and column, consecutive lines no further apart than a line.
  const blocks = [];
  const open = new Map();
  for (const f of frags) {
    const key = `${f.page}:${f.col}`;
    const b = open.get(key);
    if (b && b.bottom - f.y <= f.size * 1.5) { b.text = rejoin(b.text, f.text); b.bottom = f.y; } else {
      const nb = { page: f.page, col: f.col, top: f.y, bottom: f.y, size: f.size, text: f.text };
      blocks.push(nb);
      open.set(key, nb);
    }
  }
  // Rows: blocks whose vertical extents overlap.
  blocks.sort((a, b) => a.page - b.page || b.top - a.top);
  const rows = [];
  for (const b of blocks) {
    const hi = b.top + b.size * 0.3;
    const lo = b.bottom - b.size * 0.3;
    const row = rows.find((r) => r.page === b.page && hi >= r.lo && lo <= r.hi);
    if (row) { row.blocks.push(b); row.hi = Math.max(row.hi, hi); row.lo = Math.min(row.lo, lo); } else rows.push({ page: b.page, hi, lo, blocks: [b] });
  }
  rows.sort((a, b) => a.page - b.page || b.hi - a.hi);
  return {
    rows: rows.map((r) => {
      const cells = Array(columns.length).fill('');
      for (const b of r.blocks.sort((x, y) => y.top - x.top)) cells[b.col] = cells[b.col] ? rejoin(cells[b.col], b.text) : b.text;
      return cells;
    }),
  };
}

async function readPdf(buf) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('This is not a readable PDF file.');
  let pdfjs;
  try { pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs'); } catch { throw new Error('PDF support is not installed. Run "npm install" in roy-tutor, then try again.'); }
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: new Uint8Array(buf), isEvalSupported: false, useSystemFonts: false, cMapUrl: `${path.join(appDir, 'node_modules', 'pdfjs-dist', 'cmaps')}${path.sep}`, cMapPacked: true, verbosity: 0 }).promise;
  } catch (err) {
    throw new Error(`This PDF could not be opened (${err.message}). Save it again as PDF, or as .docx.`);
  }
  const items = [];
  const rules = {};
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    let list = null;
    try { list = await page.getOperatorList(); } catch { /* fall back to pdf.js text below */ }
    const runs = list ? textRuns(list, pdfjs.OPS) : [];
    if (runs.length) for (const r of runs) items.push({ ...r, page: n });
    else for (const it of (await page.getTextContent()).items) if (it.str) items.push({ ...it, page: n });
    try { rules[n] = list ? horizontalRules(list, pdfjs.OPS) : []; } catch { rules[n] = []; }
  }
  const readable = items.map((i) => i.str).join('').replace(/\s/g, '').length;
  if (readable < 10 * Math.max(1, Math.min(doc.numPages, 3)) / 3) {
    throw new Error('This PDF has no readable text: it looks like a scanned image. It needs OCR (text recognition) first, or add the Word (.docx) or text version of the document instead. Nothing was imported.');
  }
  if (!new RegExp(`[${HAN}]`, 'u').test(items.map((i) => i.str).join(''))) {
    throw new Error('This PDF has text but no Chinese characters, so it has no Chinese items to learn. Nothing was imported.');
  }
  const { rows, lines } = pdfRows(items, rules);
  return rows ? { entries: entriesFromRows(rows), from: `PDF table (${doc.numPages} page${doc.numPages === 1 ? '' : 's'})` } : { entries: entriesFromLines(lines), from: `PDF text (${doc.numPages} page${doc.numPages === 1 ? '' : 's'})` };
}

// ---------- any document → entries ----------

export const DOCUMENT_TYPES = ['.pdf', '.docx', '.txt', '.csv', '.tsv', '.json'];
export const MAX_DOCUMENT_BYTES = 15 * 1024 * 1024;

// A document given as its file name and contents (an upload, or a file read
// from disk). Resolves to { entries, from }; rejects with a message for Roy.
export async function readDocumentBuffer(name, buf) {
  const ext = path.extname(String(name)).toLowerCase();
  if (!DOCUMENT_TYPES.includes(ext)) throw new Error(`Unsupported file type ${ext || '(none)'}. Use PDF, Word (.docx), text (.txt), CSV, TSV or JSON.`);
  if (!buf?.length) throw new Error('The file is empty.');
  if (buf.length > MAX_DOCUMENT_BYTES) throw new Error(`The file is too large (over ${MAX_DOCUMENT_BYTES / 1024 / 1024} MB).`);
  const text = () => buf.toString('utf8').replace(/^﻿/, '');
  let out;
  if (ext === '.pdf') out = await readPdf(buf);
  else if (ext === '.json') {
    let json;
    try { json = JSON.parse(text()); } catch { throw new Error('The JSON file is not valid JSON.'); }
    const list = Array.isArray(json) ? json : json.entries;
    if (!Array.isArray(list)) throw new Error('The JSON file has no "entries" list.');
    out = { entries: list.map((e, i) => ({ ...e, position: e.position ?? i + 1 })), from: 'JSON' };
  } else if (ext === '.csv') out = { entries: entriesFromRows(parseCsvRows(text())), from: 'CSV' };
  else if (ext === '.tsv') out = { entries: entriesFromRows(text().split(/\r?\n/).map((l) => l.split('\t'))), from: 'TSV' };
  else if (ext === '.txt') out = { entries: entriesFromLines(text().split(/\r?\n/)), from: 'text' };
  else {
    let doc;
    try { doc = readDocx(buf); } catch (err) { throw new Error(`This Word file could not be read (${err.message}).`); }
    const table = doc.tables.sort((a, b) => b.length - a.length)[0];
    out = table && table.length >= 2 ? { entries: entriesFromRows(table), from: `Word table (${table.length} rows)` } : { entries: entriesFromLines(doc.paragraphs.flatMap((p) => p.split('\n'))), from: 'Word paragraphs' };
  }
  if (!out.entries.length) throw new Error('No items with Chinese were found in this document, so nothing was imported.');
  return out;
}

export function readDocument(file) {
  return readDocumentBuffer(path.basename(file), fs.readFileSync(file));
}

// CSV rows as arrays (curriculum.parseCsv returns objects keyed by header).
function parseCsvRows(text) {
  const objs = parseCsv(`${text.split(/\r?\n/)[0].split(',').map((_, i) => `c${i}`).join(',')}\n${text}`);
  return objs.map((o) => Object.values(o));
}

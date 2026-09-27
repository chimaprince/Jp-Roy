#!/usr/bin/env python3
"""Extract the JH Medics curriculum table from the source .docx.

Usage:
  python3 scripts/extract_jh_docx.py data/source/<file>.docx data/jh-medics-vol1.json

Standard library only. The document is one 3-column table
(English | Mandarin + pinyin | Meaning), one entry per row, in teaching order.

What this does to the text, and nothing more:
  * English and Meaning: outer whitespace trimmed; a line break inside a cell
    becomes one space. Spelling, capitals, punctuation and wording are kept.
  * Mandarin cell: split mechanically into the Chinese parts (-> mandarin) and
    the Latin-letter parts (-> pinyin), in source order. When a cell holds more
    than one part (alternatives on separate lines, or Chinese and pinyin
    interleaved), the parts are joined with " / ". Brackets, tone marks,
    spacing inside a part and any unmatched brackets are kept as written.
  * Every raw cell is also stored unchanged under "source" so each entry can be
    checked against the document.
Page numbers come from Word's last saved layout (lastRenderedPageBreak).
"""
import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
HAN = '\u3400-\u9fff\uf900-\ufaff'
# Full-width CJK punctuation (（）、，。 etc.) always belongs with the Chinese text.
CJK_PUNCT = '\u3000-\u303f\uff00-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65'
HAN_RE = re.compile(f'[{HAN}]')
CJK_PUNCT_RE = re.compile(f'[{CJK_PUNCT}]')
# Punctuation that belongs to the Chinese text when it sits between Chinese characters.
HAN_JOINERS = set(' \t\n/-,;:()')


def cell_text(tc):
    """Raw text of a cell: paragraphs joined with newlines; also page-break info."""
    paras, before, total, seen = [], 0, 0, False
    for p in tc.iter(W + 'p'):
        out = []
        for el in p.iter():
            if el.tag == W + 'lastRenderedPageBreak':
                total += 1
                if not seen:
                    before += 1
            elif el.tag == W + 't':
                if (el.text or '').strip():
                    seen = True
                out.append(el.text or '')
            elif el.tag == W + 'tab':
                out.append('\t')
            elif el.tag in (W + 'br', W + 'cr'):
                out.append('\n')
        paras.append(''.join(out))
    return '\n'.join(paras), before, total, seen


def read_rows(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
        app = z.read('docProps/app.xml').decode('utf8')
    declared_pages = int(re.search(r'<Pages>(\d+)</Pages>', app).group(1))
    tables = root.find(W + 'body').findall(W + 'tbl')
    if len(tables) != 1:
        raise SystemExit(f'expected 1 table, found {len(tables)}')
    rows, page, carried = [], 1, False
    for tr in tables[0].findall(W + 'tr'):
        scans = [cell_text(tc) for tc in tr.findall(W + 'tc')]
        if len(scans) != 3:
            raise SystemExit(f'row with {len(scans)} cells: {[s[0] for s in scans]}')
        # A row that starts on a new page has the marker in its first cell only.
        start_breaks = max((b for (_, b, _, has) in scans if has), default=0)
        # A long row that runs onto the next page leaves a marker inside a cell,
        # and the following row repeats a marker for the same break.
        if carried and start_breaks:
            start_breaks -= 1
        row_page = page + start_breaks
        mid_breaks = max((t - b for (_, b, t, _) in scans), default=0)
        page = row_page + mid_breaks
        carried = mid_breaks > 0
        rows.append({'page': row_page, 'cells': [s[0] for s in scans]})
    return rows, page, declared_pages


def tidy_text(s):
    """Outer whitespace off; a line break (with the spaces around it) becomes one space."""
    return re.sub(r'[ \t]*\n[ \t\n]*', ' ', s).strip()


def split_mandarin(cell):
    """Split a Mandarin cell into (chinese_parts, pinyin_parts), in order."""
    parts, cur, kind = [], '', None
    chars = list(cell)
    i = 0
    while i < len(chars):
        ch = chars[i]
        if HAN_RE.match(ch) or CJK_PUNCT_RE.match(ch):
            k = 'zh'
        elif ch.isalpha() and ch.isascii() and i + 1 < len(chars) and (HAN_RE.match(chars[i + 1]) or (chars[i + 1] == '-' and i + 2 < len(chars) and HAN_RE.match(chars[i + 2]))):
            k = 'zh'  # a lone Latin letter inside a Chinese word, e.g. x光, x-射线
        elif ch.isalpha() or ch in '()':
            k = 'py'
        elif kind == 'zh' and ch in HAN_JOINERS:
            # keep only if more Chinese follows before any Latin letter
            rest = cell[i:]
            m = re.search(rf'[{HAN}]|[^\W\d_]', rest)
            k = 'zh' if m and HAN_RE.match(m.group(0)) else 'gap'
        elif kind == 'py':
            k = 'py'
        else:
            k = 'gap'
        if k != kind:
            if cur and kind in ('zh', 'py'):
                parts.append((kind, cur))
            cur, kind = '', k
        cur += ch
        i += 1
    if cur and kind in ('zh', 'py'):
        parts.append((kind, cur))

    def clean(s, strip_chars):
        s = re.sub(r'[ \t]*\n[ \t\n]*', ' / ', s)
        return s.strip(strip_chars)

    zh = [clean(s, ' \t\n/-,;') for k, s in parts if k == 'zh']
    py = [clean(s, ' \t\n/-,;') for k, s in parts if k == 'py']
    return [z for z in zh if z], [p for p in py if p]


def build(path):
    rows, last_page, declared_pages = read_rows(path)
    entries = []
    for n, row in enumerate(rows, start=1):
        en_raw, zh_raw, meaning_raw = row['cells']
        zh_parts, py_parts = split_mandarin(zh_raw)
        entries.append({
            'position': n,
            'english': tidy_text(en_raw),
            'mandarin': ' / '.join(zh_parts),
            'pinyin': ' / '.join(py_parts),
            'meaning': tidy_text(meaning_raw) or None,
            'source_page': str(row['page']),
            'source': {'row': n, 'english': en_raw, 'mandarin': zh_raw, 'meaning': meaning_raw},
        })
    return entries, last_page, declared_pages


if __name__ == '__main__':
    src, out = sys.argv[1], sys.argv[2]
    entries, last_page, declared = build(src)
    doc = {
        'course': {'id': 'jh-medics-vol1', 'title': 'JH Medics Volume 1', 'volume': 1},
        'source_document': src.split('/')[-1],
        'source_pages': declared,
        'entries': entries,
    }
    with open(out, 'w', encoding='utf8') as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print(f'{len(entries)} entries, pages 1-{last_page} (document says {declared})')

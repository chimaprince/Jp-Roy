#!/usr/bin/env python3
"""Check the imported curriculum against the source .docx, independently of the extractor.

Usage:
  python3 scripts/validate_jh_import.py data/source/<file>.docx data/jh-medics-vol1.json [tutor.db]

Reads the Word table again, then checks, for every row:
  - the JSON has one entry per table row, in row order, positions 1..N;
  - the raw cells stored in the JSON are exactly the document's cells;
  - English and meaning match the document (only line breaks and outer spaces differ);
  - every Chinese character and full-width mark in the Mandarin cell is in
    `mandarin`, same order, nothing added;
  - every letter of the Mandarin cell (pinyin, tone marks, the x of x光) is in
    `mandarin` + `pinyin`, nothing added or lost, and pinyin letters keep their order;
  - page numbers start at 1, never go backwards and stay within the page count;
and, if a database is given, that its rows equal the JSON exactly.
Exit status 0 means every check passed. Notes (duplicates, missing pinyin,
unmatched brackets, multi-part cells) are listed for review but are not failures,
because they are how the source is written.
"""
import json
import re
import sqlite3
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter

W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
HAN_OR_CJK = re.compile('[㐀-鿿豈-﫿　-〿＀-￯]')


def doc_rows(path):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read('word/document.xml'))
        pages = int(re.search(r'<Pages>(\d+)</Pages>', z.read('docProps/app.xml').decode()).group(1))
    rows = []
    for tbl in root.find(W + 'body').findall(W + 'tbl'):
        for tr in tbl.findall(W + 'tr'):
            cells = []
            for tc in tr.findall(W + 'tc'):
                paras = []
                for p in tc.iter(W + 'p'):
                    out = []
                    for el in p.iter():
                        if el.tag == W + 't':
                            out.append(el.text or '')
                        elif el.tag == W + 'tab':
                            out.append('\t')
                        elif el.tag in (W + 'br', W + 'cr'):
                            out.append('\n')
                    paras.append(''.join(out))
                cells.append('\n'.join(paras))
            rows.append(cells)
    return rows, pages


def squash(s):
    return re.sub(r'\s+', ' ', s or '').strip()


def cjk(s):
    return ''.join(HAN_OR_CJK.findall(s or ''))


def letters(s):
    return ''.join(ch for ch in (s or '') if ch.isalpha() and not HAN_OR_CJK.match(ch))


def is_subsequence(small, big):
    it = iter(big)
    return all(ch in it for ch in small)


def main(docx, json_path, db_path=None):
    rows, declared_pages = doc_rows(docx)
    data = json.load(open(json_path, encoding='utf8'))
    entries = data['entries']
    failures, notes = [], []

    if len(entries) != len(rows):
        failures.append(f'document has {len(rows)} rows but JSON has {len(entries)} entries')
    for i, (e, cells) in enumerate(zip(entries, rows), start=1):
        tag = f'#{i} ({squash(cells[0])})'
        if e['position'] != i:
            failures.append(f'{tag}: position is {e["position"]}, expected {i}')
        src = e.get('source', {})
        if [src.get('english'), src.get('mandarin'), src.get('meaning')] != cells:
            failures.append(f'{tag}: stored raw cells differ from the document')
        if squash(e['english']) != squash(cells[0]) or e['english'] != e['english'].strip():
            failures.append(f'{tag}: english differs from the document')
        if squash(e['meaning']) != squash(cells[2]):
            failures.append(f'{tag}: meaning differs from the document')
        if cjk(e['mandarin']) != cjk(cells[1]):
            failures.append(f'{tag}: Chinese characters differ: {cjk(cells[1])!r} vs {cjk(e["mandarin"])!r}')
        if Counter(letters(e['mandarin']) + letters(e['pinyin'])) != Counter(letters(cells[1])):
            failures.append(f'{tag}: pinyin letters added or lost')
        elif not is_subsequence(letters(e['pinyin']), letters(cells[1])):
            failures.append(f'{tag}: pinyin letters out of order')
        # Every non-space character of the cell must be in mandarin + pinyin. The
        # extractor may only add the " / " between parts and drop separators
        # ("-", ",", ";", "/") left dangling at a part's edge.
        raw_c = Counter(re.sub(r'\s', '', cells[1]))
        got_c = Counter(re.sub(r'\s', '', e['mandarin'] + e['pinyin']))
        added = got_c - raw_c
        lost = raw_c - got_c
        joins = (e['mandarin'] + ' ' + e['pinyin']).count(' / ')
        if set(added) - {'/'} or added['/'] > joins:
            failures.append(f'{tag}: characters added to mandarin/pinyin: {dict(added)}')
        if set(lost) - set('-,;/'):
            failures.append(f'{tag}: characters lost from the Mandarin cell: {dict(lost)}')
        elif lost:
            notes.append(f'{tag}: separator dropped at a part edge: {"".join(lost.elements())!r} in {cells[1]!r}')
        page = int(e['source_page'])
        prev = int(entries[i - 2]['source_page']) if i > 1 else 1
        if not (1 <= page <= declared_pages) or page < prev:
            failures.append(f'{tag}: page {page} out of order or range')

        # Review notes: how the source is written, kept as is.
        if not e['pinyin']:
            notes.append(f'{tag}: no pinyin in the source')
        for field in ('english', 'mandarin', 'pinyin'):
            v = e[field]
            if v.count('(') + v.count('（') != v.count(')') + v.count('）'):
                notes.append(f'{tag}: unmatched bracket in {field}: {v}')
        if ' / ' in e['mandarin']:
            notes.append(f'{tag}: several Mandarin forms in one cell, joined with " / ": {e["mandarin"]} | {e["pinyin"]}')
    if entries and entries[0]['source_page'] != '1':
        failures.append('first entry is not on page 1')

    for field in ('english', 'mandarin'):
        seen = Counter(squash(e[field]).lower() for e in entries)
        for value, n in seen.items():
            if n > 1:
                where = [e['position'] for e in entries if squash(e[field]).lower() == value]
                notes.append(f'repeated {field} "{value}" at positions {where} (kept, as in the source)')

    if db_path:
        con = sqlite3.connect(db_path)
        con.row_factory = sqlite3.Row
        db = con.execute("SELECT * FROM curriculum WHERE course_id = ? ORDER BY position", (data['course']['id'],)).fetchall()
        if len(db) != len(entries):
            failures.append(f'database has {len(db)} rows, JSON has {len(entries)}')
        for e, r in zip(entries, db):
            for field in ('position', 'english', 'mandarin', 'pinyin', 'meaning', 'source_page'):
                if e[field] != r[field]:
                    failures.append(f'#{e["position"]}: database {field} {r[field]!r} != JSON {e[field]!r}')

    print(f'Source rows: {len(rows)}  JSON entries: {len(entries)}  Pages: {declared_pages}')
    print(f'Failures: {len(failures)}')
    for f in failures:
        print('  FAIL', f)
    print(f'Notes for review: {len(notes)}')
    for n in notes:
        print('  NOTE', n)
    print('VALIDATION PASSED' if not failures else 'VALIDATION FAILED')
    return 0 if not failures else 1


if __name__ == '__main__':
    sys.exit(main(*sys.argv[1:4]))

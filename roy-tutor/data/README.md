# Curriculum data

`courses.json` lists which courses the app loads: one `active` course, any
number of `staged` (waiting) ones. Today only **JH Medics Volume 1** is listed,
and it is active. Further documents are added with `npm run course -- add`
(see the main README, "Courses"); they wait until activated. Every course is
taught by the same teacher; a course only supplies its items and their order.

`jh-medics-vol1.json` is the source of truth for the curriculum. Entries are
taught strictly by `position`, from 1 to the last entry.

## Volume 1 source and how it was imported

- Source: `source/JH_MEDICS_TRAINING_MANDARIN11.docx` (31 pages, one table of
  385 rows: English | Mandarin + pinyin | Meaning).
- `jh-medics-vol1.json` is generated from it, one entry per table row, in row order:

  ```
  python3 scripts/extract_jh_docx.py data/source/JH_MEDICS_TRAINING_MANDARIN11.docx data/jh-medics-vol1.json
  npm run import
  python3 scripts/validate_jh_import.py data/source/JH_MEDICS_TRAINING_MANDARIN11.docx data/jh-medics-vol1.json tutor.db
  ```

- Each entry keeps the document's raw cells under `source`, so any entry can
  be checked against the Word table.
- What the extractor changes, and nothing more: outer spaces are trimmed, line
  breaks inside English and Meaning cells become a space, and the Mandarin cell
  is split into Chinese (`mandarin`) and Latin-letter (`pinyin`) parts. A cell
  with several parts is joined with " / ". A separator ("-" or ",") left
  dangling at the edge of a part is dropped, and the validator lists each one.
- Page numbers come from Word's last saved layout. They run 1–31, which matches
  the document's own page count.
- `jh-medics-vol1.validation.txt` is the latest validation report. The source
  is kept as written, including typos (for example "examintion", "tendernes"),
  unmatched brackets, repeated entries and two entries with no pinyin
  (161, 163). The report lists all of them for review.

## Rules the importer enforces

- Values are stored **exactly as written**. Nothing is trimmed, re-toned,
  re-spelled or "corrected". An entry that looks odd stays as it is.
- Positions must be unique whole numbers starting at 1 with no gaps. If they
  are not, the import stops and changes nothing.
- `english` and `mandarin` are required. `pinyin`, `meaning` and
  `source_page` may be empty; the importer prints which entries lack them.
- Re-importing keeps each entry's database id (matched by course + position),
  so Roy's progress is kept.

## Adding Volume 2 later

1. Add `jh-medics-vol2.json` in the same format (`course.id`: `jh-medics-vol2`).
2. Add it to `courses.json` with `"status": "staged"` and
   `"requires": "jh-medics-vol1"`. Staged courses are imported but never taught.
3. When Volume 1 is finished and tested, change Volume 2 to `"active"` and
   Volume 1 to `"retired"`. Roy's Volume 1 progress stays in the database.

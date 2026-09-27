# Curriculum data

`courses.json` lists which courses the app loads. Only **JH Medics Volume 1**
is listed, and it is the only `active` course. Volume 2 must not be listed yet.

`jh-medics-vol1.json` is the source of truth for the curriculum. Entries are
taught strictly by `position`, from 1 to the last entry.

## Status of the Volume 1 file

Only entry 1 (`epidural` / `硬膜外` / `yìng mó wài`) is in the file so far. Its
`meaning` and `source_page` are `null` because the JH Medics wording was not
supplied, and the app must not invent one. The tutor says the meaning has not
been loaded yet instead of making one up.

To load the full volume, replace `entries` with every entry from the book, in
book order, and run `npm run import`. You can also import a CSV:

```
npm run import -- --file data/jh-medics-vol1.csv --course jh-medics-vol1
```

CSV columns: `position,english,mandarin,pinyin,meaning,source_page`.

## Rules the importer enforces

- Values are stored **exactly as written**. Nothing is trimmed, re-toned,
  re-spelled or "corrected". An entry that looks odd stays as it is.
- Positions must be unique whole numbers starting at 1 with no gaps. If they
  are not, the import stops and changes nothing.
- `english`, `mandarin` and `pinyin` are required. `meaning` and `source_page`
  may be empty, and the importer prints which entries have no meaning.
- Re-importing keeps each entry's database id (matched by course + position),
  so Roy's progress is kept.

## Adding Volume 2 later

1. Add `jh-medics-vol2.json` in the same format (`course.id`: `jh-medics-vol2`).
2. Add it to `courses.json` with `"status": "staged"` and
   `"requires": "jh-medics-vol1"`. Staged courses are imported but never taught.
3. When Volume 1 is finished and tested, change Volume 2 to `"active"` and
   Volume 1 to `"retired"`. Roy's Volume 1 progress stays in the database.

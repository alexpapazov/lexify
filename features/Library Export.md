# Library Export

**Status: built 2026-08-11. No migration, no dependency.**

Every level of the library exports its own subtree — a language pair, a folder, or a single deck —
from the ⚙ gear at that level. Four formats: copy as text, `.txt`, Word `.docx`, and PDF.

---

## One gear per level

`components/library/LibraryGearMenu.tsx` is the shared dropdown. Each level passes its own `items`
(New folder, Onboard, Delete folder, Study settings…) and the menu appends the two SHARED actions:
**Label cards** and **Export**. Keeping one component is what stops the export format and the
labeling scope drifting apart between levels.

| Level | Where | Level-specific items |
|---|---|---|
| Language pair | `app/library/page.tsx` header (replaced "+ New folder") | + New folder |
| Folder | `app/library/folder/page.tsx` header | + New subfolder, Onboard vocabulary, Delete folder |
| Deck | `app/study/deck/page.tsx` header | Study settings… (opens the existing modal) |

**Both shared actions are SCOPED, never "everything"** — exporting from a deck must not dump the
whole library, and labeling from a folder must not spend model calls on unrelated decks. Labeling
also skips already-labeled cards (`c.pos`) and de-dupes shared cards, so a second run is cheap.

## The tree

`buildLibraryExport(scope, folders, decks, userId)` assembles an `ExportTree`. **Folders and decks
are passed IN** — every caller already has them loaded, and re-fetching would double the page's
queries just to export. Only the cards are fetched, in one paged `listForDecks` call (which also
skips the audio blobs).

A pair's folders use the same permissive membership rule as the library view (stamped with the pair,
or containing any of its decks), so the export matches what's on screen.

## Formats

| Format | How |
|---|---|
| Copy as text | `renderLibraryText` → clipboard |
| `.txt` | same string, downloaded |
| `.docx` | `lib/docxWrite.ts` — a real ZIP of OOXML, **no dependency** |
| PDF | `openLibraryPdf` — a styled print window; the user picks "Save as PDF" |

**Why PDF is a print window and not a generated file.** A PDF written without an embedded font can
only use the base-14 fonts, which are Latin-1. This library is mostly Korean, Greek, Cyrillic and
Chinese — all of it would render as garbage — and embedding a CJK-capable font means shipping
megabytes. Printing hands the job to the OS, which already has the right fonts. `openLibraryPdf`
returns false when the popup is blocked so the caller can say so instead of appearing to do nothing.

**`lib/docxWrite.ts` has no dependency for the same reason `lib/docx.ts` (the reader) doesn't:** a
`.docx` is a ZIP of XML and the platform ships `CompressionStream('deflate-raw')`; only a small CRC32
is hand-written. Three parts are emitted (`[Content_Types].xml`, `_rels/.rels`, `word/document.xml`).

## The export re-imports

`renderLibraryLines` writes folder and deck names **bold with descending sizes** — exactly the
heading signal `parseDeckPlan` looks for in a document with no Word heading styles — and cards as
plain `front = back` lines. So an exported `.docx` can be edited in Word and fed straight back
through batch import as the same tree. There's a round-trip test.

**Keep the deck NAME clean.** The card count lives on its own line, not appended to the name: the
round-trip test caught a re-imported deck literally called `School  [12 cards]`. The count line is
ignored on re-import because it has no `=` separator.

---

## Error log

*(none yet — never run against a real account)*

## Known gaps

- The `.docx` is deliberately minimal — no styles part, no TOC, no page numbers. It opens in Word,
  Pages and Google Docs, but it is a plain document, not a designed one.
- PDF depends on pop-ups being allowed; the menu says so when blocked.
- Export is online-only in practice (it reads cards through the repo, which is offline-guarded but
  the offline bundle may not hold the whole scope).

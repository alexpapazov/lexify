# Batch Deck Import (Word document → folders + decks)

**Status: built 2026-07-30. No migration needed.**

Mass intake: write (or have an assistant write) a structured vocabulary document, drop it into Create,
and get the folders and decks its headings describe. **No AI anywhere in this flow.** The `.docx` is
parsed on the device — nothing is uploaded, no model is called.

Entry point: **Create → the "Single deck / Batch of decks" toggle at the top.**

---

## 1. The document format

```
First 200                      ← 16pt bold  → FOLDER
Articles and Determiners       ← bold       → DECK
el = the
la = the
Pronouns                       ← bold       → DECK
yo = I
```

The rule is structural, not stylistic: **a heading with word lines directly under it becomes a deck; a
heading with only sub-headings becomes a folder.** Nesting is unlimited — three heading levels give
folder → subfolder → deck.

Two ways a heading is recognised, in priority order:

1. **Real Word heading styles** — `Heading1`…`Heading9`, `Title`, or `w:outlineLvl`. When the document
   uses any of these, ONLY they count as headings; bold text is then ordinary emphasis and is ignored.
2. **Bold + font size** — otherwise, bold lines are headings, ranked by font size, largest = shallowest.
   Sizes are ranked, not thresholded, so any size scheme works. The document default size sorts last
   (an explicit size is only ever set on something the author wanted to stand out).

That second path matters because assistant-generated documents frequently use direct bold formatting
rather than real heading styles — `Spanish_First_200.docx` has **no `w:pStyle` at all**.

**A bold line that parses as a word line is treated as vocabulary, not a heading.** Losing a heading
merges two decks; losing a line loses vocabulary, and that is the worse failure.

Word lines split on the **first** separator (default `=`, configurable; a tab is always accepted), so
a gloss may itself contain one — `ser = to be = exist` → front `ser`, back `to be = exist`. Lines with
no separator are collected in `unparsed` and reported before the import starts, never silently dropped.

## 2. Architecture

`lib/docx.ts`, three layers so the interesting one is testable without a binary fixture:

| Layer | Function | Notes |
|---|---|---|
| ZIP | `unzipEntry(buffer, name)` | A `.docx` is a ZIP. Uses the platform `DecompressionStream('deflate-raw')` — **no zip dependency added**. Handles stored + deflate. |
| XML | `extractDocxParagraphs(xml)` | WordprocessingML → `{text, bold, sizeHalfPoints, outlineLevel}`. Pure. |
| Structure | `parseDeckPlan(paragraphs, opts)` | → `{decks: [{path, name, cards}], unparsed}`. Pure; all the rules above live here. |

`readDeckPlanFromFile(file)` glues them. Tested in `lib/__tests__/docx.test.ts` (24 tests), including
a real round-trip through a ZIP built in the test with `CompressionStream`.

**Paragraphs never nest** (table cells contain them; they don't contain each other), so the flat regex
scan is safe — and it means word lines inside a *table* are picked up in document order too.

**Browser support:** `DecompressionStream` needs Chrome 80+ / Safari 16.4+ / Firefox 113+. That covers
the desktop PWA and iOS 16.4+ WKWebView. An older device gets a thrown error, surfaced as a parse
failure — it does not fail silently.

## 3. The save flow

`components/create/BatchDeckImport.tsx`. You pick **the library** (a language pair — that's the only
choice, since names come from the document) and the file, then review a plan summary.

Decks are then saved **one at a time**, each a two-step gate: first press checks and flags, second
press confirms. That is the entire reason not to save them in one batch — you decide what happens to
each collision. Per flagged card: *Use the existing card / Leave it out / Add anyway / Replace the
existing card*. Plus **Remove all duplicates** and **Add all anyway** to move fast, and
**Skip this deck**.

### Duplicates here are FRONT-ONLY

The gloss plays no part. `analyzeFrontDuplicate` matches on `normalizeFrontKey` alone — the same word
twice is a duplicate whatever the meanings say, because two cards for one word means two competing
schedules. This is the rule that closes the leak: front+back matching couldn't see a library holding
"cielo = sky" against an imported "cielo = heaven", so hundreds of duplicates slipped through a real
import.

Consequences worth knowing:

- **Genuine homographs are flagged too** — *vino* (wine / he came), *banco* (bank / bench). Use
  **Add anyway** per card. "Remove all duplicates" would drop them, which is an accepted trade.
- The default action on a library hit is **merge** — reuse the card you already have.
- A repeat *within the same deck* gets the `skip` action rather than merge: neither copy is saved yet,
  so there is no card to reuse.
- Checked against the library **and** against cards created earlier in the same import — the in-memory
  library is appended after each deck saves, because a word easily appears under two headings.

Folders are created lazily per deck and **reused by name** at each level (case-insensitively, matching
the pair or an unscoped folder), so re-importing a document doesn't fork the tree. Resolved ids are
cached by path so a shared parent is created once.

### Deliberately skipped, because they're AI

- **Distractor pre-generation** (`prefetchChoices`) — the single-deck save does this; batch does not.
  198 cards would be 198 model calls. Distractors are generated lazily at study time anyway.
- **Language syncing** — an AI translation pass into other pairs. Not offered here.

Kept, because it's deterministic: `autoGroupByGloss` (cards sharing an exact gloss are grouped).

---

## Error log

*(none yet — feature is new as of 2026-07-30)*

## Known gaps

- A heading with BOTH word lines and sub-headings becomes a folder containing a deck of the same name.
  Unambiguous but slightly odd-looking; no better option exists since decks can't nest.
- Deck names are not deduplicated against existing decks — importing the same document twice creates a
  second set of decks in the same (reused) folders. The card-level duplicate check still fires, so you
  won't get duplicate *cards*, but you will get duplicate deck shells.
- `.doc` (the old binary format), `.odt` and PDF are not supported — `.docx` only.

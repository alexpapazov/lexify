# Phrasebook (proposal — NOT built)

> **Status: idea, deliberately deferred (2026-09-21).** Recorded so it can be picked up later.
> Nothing in the codebase implements any of this yet. When building, start at Stage 1 and ship
> stages independently.

## The idea

Cards teach **words**; nothing in Lexify teaches **how words combine**. A phrasebook is a per-
language-pair collection of things above the word level — idioms ("все пак") and grammatical
constructions ("би трябвало + да-clause") — whose mastery signal is *usage in free writing*, not
flashcard recall. The journal (shipped 2026-09-21, `/study/journal`) is the evidence stream; the
phrasebook is what turns it into a learning loop:

1. Keep a phrasebook of idioms/constructions you're working on.
2. Analyze journal entries: which items were used, quoted, judged correct / awkward / incorrect.
3. Aggregate per item → a mastery view (times used, times correct, last used).
4. Generate journal **prompts from struggles**: pick low/awkward-usage items, prompt an entry
   that elicits them, and record which items the prompt targeted — the next analysis then shows
   whether the prompt worked (closes the loop).

The journal's `notes` field (new words / grammar jotted while writing) is a natural intake funnel:
things noted there are phrasebook candidates.

## Data model (sketch)

`phrasebook_items` (per language pair):

| column | notes |
|---|---|
| `kind` | `'idiom' \| 'construction'` |
| `text` | the phrase or pattern itself |
| `meaning` | native gloss / explanation |
| `example` | one example sentence |
| `source` | `'manual'` \| `'journal'` (spotted in an entry) \| later `'ai'` |

Analysis results are stored **on the journal entry** (JSONB, e.g. `phrasebook_usage:
[{itemId, quote, verdict, note}]`) — same store-what-happened / derive-what-is-true rule as
everywhere else (see 122's header): never re-run analysis on view, aggregates derive from stored
analyses. Prompts store `{text, targetItemIds}` (the journal's `prompt` column exists already,
migration 125).

**Deliberately separate from cards.** Idioms could arguably be cards, but constructions aren't
recall items. An optional "make a card from this idiom" bridge can come later.

## Design rules (agreed up front)

- **Schedule-neutral**, like journal/practice/drill: nothing here touches FSRS, reviews, or goals.
- **Analysis is on-demand** (an "Analyze" button on an entry), not automatic on save — cost stays
  visible and writing never slows down. Results are stored once.
- Analysis model: **Sonnet**, not Haiku — judging free prose is beyond the fast tier.
- Online-only, like the journal.

## Build order (each stage useful alone)

1. **Phrasebook CRUD page** — data-only, same shape as journal v1 (list + add/edit/delete,
   per pair). One migration.
2. **Per-entry Analyze** — one Sonnet call: entry + phrasebook in, usages/verdicts/notes out,
   stored on the entry, rendered as annotations.
3. **Mastery view** — per-item aggregates derived from stored analyses.
4. **Struggle-driven prompts** — generate a prompt targeting weak items; store target ids; the
   follow-up analysis reports whether they were used.

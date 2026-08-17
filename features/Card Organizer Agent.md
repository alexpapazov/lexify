# Card Organizer Agent

**Status: rebuilt as a migration planner 2026-08-11. No migration, no dependency.**
`/agents/organizer`. Sorts cards you already have into folders and decks. It never edits card text —
only where a card lives — so review history, audio, distractors and every other deck a card is shared
into survive untouched.

---

## How it works

Four stages, in this order, because each one exists to make the next one trustworthy:

1. **Export the scope.** A hierarchical text export of the selected decks (the same renderer the
   library's Export uses). Feeding the model the TREE rather than a flat card list is what lets it
   reason about folders and whole decks instead of only individual cards.
2. **Diagnose deterministically.** Duplicated words, document words that aren't in scope, and cards
   that live elsewhere in the library and could be pulled in — all computed in `migrationPlan.ts`,
   never asked of the model. Computation is exact and free; a model auditing its own input is
   neither. The results are handed to the planner as FACTS it's told to trust.
3. **Plan.** One call to `/api/agents/organizer-plan` with the export, the instruction and the
   documents. Returns an ordered list of steps plus a summary.
4. **Validate, preview, run.** Every id is re-checked against the real library, the plan is shown
   grouped for review, and one approval runs the whole thing — reversibly.

## The instruction is ground truth; documents are evidence

Stated in the system prompt and load-bearing: the **instruction** says how to read the **documents**
(follow them literally, use them as a grouping hint, ignore parts). If they disagree, the instruction
wins. That's why the two are separate fields in the request rather than one concatenated blob.

Either alone is enough to run: documents with no instruction are followed as literally as possible;
an instruction with no documents reorganizes from the library alone.

## Steps

| Kind | Effect |
|---|---|
| `createFolder` | Creates a folder path (reused by name if it exists) |
| `moveFolder` | Reparents a folder |
| `moveDeck` | Moves a whole deck into a folder |
| `moveCard` | Relinks one card into a (possibly new) deck; `pullIn` marks one from outside the scope |
| `deleteDeck` / `deleteFolder` | Removes an EMPTY container — run last, refused at run time if anything is inside, undone via `restore()` |

**"🧹 Delete empty folders & decks" chip (2026-08-12)** — a Common-tasks button on the setup screen.
Fully DETERMINISTIC: "empty" is computable, so no model call. Scans the WHOLE library (an empty
folder can't be selected through the deck-based scope picker), cascades folder emptiness to a
fixpoint (a folder holding only empty folders is itself empty), and drops the delete steps into the
normal review → apply → undo flow. Deck emptiness reads `listForDecks` — NOT `deckIdsByCard`, which
keeps only each card's first deck and would misread a deck of shared cards as empty. The "What the
planner read" panel hides for these plans (`libraryText: ''` — there was no planner).

**No renames.** Deletions exist (2026-08-12) but only for EMPTY containers — the executor re-checks
emptiness at run time and refuses rather than cascades, so a deletion can never take contents with
it. Folder deletions run deepest-first via a client-computed depth. `orderSteps` runs createFolder → moveFolder →
moveDeck → moveCard, with parent folders created before children, so a destination always exists
before something moves into it. The prompt also tells the planner to prefer one `moveDeck` over fifty
`moveCard`s that add up to the same thing: fewer steps to review, fewer writes to run.

## The model plans; it is never trusted

`validatePlan` drops any step whose id isn't in the client's own copy of the library — an invented
card, a deck outside the scope, a pull-in the user didn't authorize, a folder move that would nest a
folder inside itself, an empty path, or a no-op. Dropped steps are SHOWN ("3 proposed steps
discarded") rather than hidden, so a bad plan is visible rather than silently thinned.

**Sonnet 5, not Haiku.** This reads a whole library export and plans globally over it; the per-batch
"where does this card go" call it replaced was a far smaller job. A weaker model produces
plausible-looking plans that are wrong in the middle — the worst possible failure for something
approved in one click.

## Diagnostics, and what you can do about them

- **Duplicate** — the same word on more than one card in scope. A card *shared* into several decks is
  one card in several places and is NOT flagged. Checked with `normalizeFrontKey`, so "il gatto",
  "Il Gatto" and "gatto (m)" are one word here exactly as they are everywhere else.
- **Out of scope** — a document word that exists in the library but outside the selection. Offered as
  a pull-in when "May pull in cards from outside the scope" is on; otherwise reported and untouched.
- **Missing** — a document word that exists nowhere. Nothing can be moved; it's surfaced so you can
  see what the document expected.

Duplicates and missing words each have an "ignore" toggle. **Out-of-scope is never suppressed** — it
is an offer, not noise.

## Applying and undoing

`runMigration` executes in order and records a journal entry per step BEFORE it runs; **Undo
migration** replays it backwards. A failing step does not abort the run — the rest of a plan is
usually independent, and stopping halfway leaves a library in a state nobody chose. Failures are
collected and reported, and everything that did land stays undoable.

**Order rule, inherited and non-negotiable:** a card move links the destination FIRST and unlinks the
source SECOND. A crash between them leaves the card in both places (visible, trivially fixed) rather
than in neither, which is indistinguishable from data loss. Undo mirrors it.

**Undo deletes folders the migration created**, unlike the old per-move undo which left them behind.
That is only safe because the journal records the exact folder created and undo runs in reverse, so
anything the migration put inside has already been moved back out. Pre-existing folders are never
touched.

---

## Scaling: thousands of cards (2026-08-12)

One giant model call dies at scale — output ceilings, function timeouts, "Failed to fetch" (both were
hit on the first real runs). The planner is now sized to the load, all inside `planMigration`:

- **Short ids** (`lib/agents/modelExport.ts`): the model reads `[f1]`/`[d2]`/`17: front = back` and
  answers in the same vocabulary; the client translates back and fills every echo field from its own
  data. A UUID is 36 characters — short ids are the difference between "fits" and "doesn't". They
  also closed a real hole: the old export had NO ids, so every container/card step the model proposed
  was validator-dropped.
- **Small scope (≤60k chars of library+docs)**: the single-shot plan, as designed.
- **Big scope**: (1) a STRUCTURE call over the tree (no card lines) + document outlines returns
  container steps, a route for every doc section, and a leftover policy; (2) doc-listed cards are
  moved DETERMINISTICALLY client-side (`resolveDocMoves`, normalizeFrontKey matching — free at any
  size); (3) leftovers hit the model again only if the structure stage chose `judge` — batches of
  250 with a numbered destination menu.
- **Transport**: `maxDuration = 300`, streamed Anthropic call, per-mode token ceilings, truncation
  salvage that keeps every complete step, NOTES lists capped at 60 entries.

## Error log

- 2026-08-12 — "The planner did not return a usable plan": 16k output ceiling truncated the JSON
  mid-plan. Fixed with the salvage parser + 32k ceiling.
- 2026-08-12 — "Failed to fetch" on a big scope: no maxDuration + non-streamed call; the function
  died mid-generation. Fixed by the staged pipeline + streaming + maxDuration.
- 2026-08-12 — the export sent to the model contained no ids, so every proposed step referenced
  invented ids and was dropped. Fixed by the short-id export.

## Known gaps

- **One language pair per run.** The context takes its pair from the first scoped deck.
- **No rename or delete.** A reorganization that needs them has to be finished by hand; decks the
  migration empties are left in place.
- **Online only**, like every agent.
- A very large scope can hit the planner's token ceiling; `truncated` is surfaced as a warning rather
  than a silent partial plan.

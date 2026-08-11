# Card Organizer Agent

**Status: built 2026-08-10. No migration.** Second agent on the Agents page
(`/agents/organizer`, picker chips at the top of both agent pages).

Sorts cards you already have into folders and decks. It never edits card text — only where a card
lives — so review history, audio, distractors and every other deck a card is shared into survive
untouched.

---

## The one thing that makes it safe

**A move is a `deck_cards` RELINK, not a card rewrite.** A card row is linked to decks; organizing
means link the destination, unlink the source. Consequences worth stating:

- Review state (`card_states`), climb rows, audio and cached distractors are all keyed to the CARD,
  so none of them are touched by a move.
- A card shared into several decks keeps its other links — only the link in the scoped deck moves.
  Organizing Spanish can't strip a card out of a Korean deck.
- **Order is fixed: link the destination FIRST, unlink the source SECOND** (`lib/agents/organizerApply.ts`).
  A crash between the two leaves the card in BOTH places — visible and trivially fixed. The reverse
  order would leave it in neither, which is indistinguishable from data loss. Never swap them.
  `undoMove` follows the same rule in reverse.

---

## Two ways to say where a card belongs

### 1. Word documents — deterministic, NO AI

Drop one or more `.docx` files. They're parsed by the SAME `lib/docx.ts` pipeline batch import uses
(`readDeckPlanFromFile` → headings become folders, the deepest heading over a word list becomes its
deck). Here the plan is read as a **destination map**: "wherever this word appears in the document,
that's where its card belongs".

- Matching is by FRONT, through `normalizeFrontKey` — so articles, grammatical tags, case and
  whitespace differences between the card and the document don't miss a match.
- **Cards the document never mentions are LEFT ALONE** and reported. A document says where the words
  it lists belong; it says nothing about the rest, and sweeping unlisted cards into some "other"
  bucket would act on an instruction the user never gave.
- A word listed under two headings is ambiguous: the FIRST occurrence wins and the rest are counted
  in the notes. Silently taking the last would quietly undo an earlier deliberate placement.
- Multiple files merge into one plan, earlier files winning conflicts — the same first-occurrence
  rule, one level up.

### 2. Natural language — batched model calls

"Group these by topic", "split the verbs into Verbs/Regular and Verbs/Irregular". `POST
/api/agents/card-organizer` returns `{cardId, path, reason}` per card, in batches of 40.

- The model may ONLY choose a destination path. It cannot edit, split or delete, and there is no
  tool-use loop — one structured JSON answer per batch.
- The library's existing folder/deck paths are passed in and the prompt insists on reusing them. That
  is what stops "Foods" appearing beside "Food".
- **Every id is re-validated locally** by `planMovesFromAssignments` against the batch that was sent.
  An invented id, an out-of-scope card, an empty path, or a no-op (card already there) is dropped
  rather than trusted.

Both paths converge on `MoveProposal[]` and the same review queue.

---

## Review

Proposals are grouped BY DESTINATION (`groupByDestination`), because approving a destination is the
natural unit — "yes, all 14 of these are food words". Per group you can move all, skip the group, or
leave individual cards behind. **Undo last** reverses the whole group just applied.
"Accept all N remaining" is behind a confirmation and deliberately NOT undoable as a unit (the
`lastApplied` snapshot holds one group; pretending otherwise would be a lie).

A partial failure mid-group keeps whatever landed (still undoable) and leaves the rest queued, rather
than advancing past a half-applied group.

## Folders and decks are created on demand

`ensureFolderPath` / `ensureDeck` reuse a same-named folder or deck at their level — the same rule as
`BatchDeckImport.ensureFolderPath`, deliberately, so the two features can't fork each other's trees.
A folder with no language pair of its own matches too (those are shared folders).

`OrganizerContext` carries the live `folders`/`decks` arrays and is MUTATED as things are created, so
a run of twenty moves into one new folder creates it once.

**Undo does not delete folders or decks the move created.** An empty deck is visible and trivially
removed by hand; auto-deleting risks removing a folder the user has meanwhile put something else in.

---

## Files

| Piece | Where |
|---|---|
| Planning (pure, 19 tests) | `lib/agents/cardOrganizer.ts` — `planMovesFromDocument`, `planMovesFromAssignments`, `destinationsFromPlan`, `alreadyThere`, `groupByDestination` |
| Applying | `lib/agents/organizerApply.ts` — `applyMove`, `undoMove`, `ensureFolderPath`, `ensureDeck` |
| AI route | `app/api/agents/card-organizer/route.ts` |
| Page | `app/agents/organizer/page.tsx` |
| Shared scope picker | `components/agents/ScopeTreePicker.tsx` (extracted from the card-editor page; both use it) |

---

## Error log

*(none yet — never run against a real account)*

## Known gaps

- **Single language pair per run.** `OrganizerContext` takes its pair from the first scoped deck, so
  a scope spanning two pairs would create destination decks in the first pair's languages. Select one
  pair at a time until this is fixed.
- **Online only** — no offline path, like every other agent.
- The AI path sends up to 200 existing paths; a very large library could exceed that and start
  inventing names for the unlisted parts of the tree.
- No dry-run preview of the whole plan before the first group is approved (you see one group at a
  time plus a short "then:" list).

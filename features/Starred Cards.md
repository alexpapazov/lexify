# Starred Cards

**Status: built 2026-08-08. Migration `112_card_starred.sql` — PENDING, apply before deploying
(card SELECTs name the new column).**

A manual "come back to this one" flag, set from a star in the **top-left corner** of a study card
(mirroring the ℹ button on the right). Filterable in the deck view, the library, and as a Practice
Mode target source.

## Why it isn't derived

Difficulty and lapses already answer "which words are hard for me". A star answers something the
scheduler can't see: a word you love, one your teacher flagged, one whose gloss you don't trust yet,
one you want to use in writing this week. Keeping it manual is the whole point — Practice offers
**Hardest** (inferred) and **★ Starred** (declared) as separate sources for exactly that reason.

## Data

| Piece | Where |
|---|---|
| Migration | `supabase/migrations/112_card_starred.sql` — `cards.starred BOOLEAN NOT NULL DEFAULT false`, plus a partial index `WHERE starred` (starred cards are queried as their own small set) |
| Domain | `Card.starred?: boolean` |
| Repo | `cardRepo.setStarred(cardId, starred)` — its own method rather than `update`, because starring happens mid-session on one tap and must not drag a whole card payload (or a stale `choices`) along with it. Added to both column allowlists so every read carries it |

## The button

`components/session/StarButton.tsx`, rendered wherever `CardInfoButton` is — **every study mode**:
`FlashcardMode`, `TypingMode`, `MultipleChoiceMode`, `SynonymDueNowMode`, `ConfusionDrill`, and
through `LadderStudyCard` for the ladder. Each takes an optional `onToggleStar`; omit it and no star
appears (the re-rate view, for instance).

**Optimistic**: the star fills on press and the write goes off in the background, so the gesture
never blocks the card. A failed write reverts the star silently — an error banner mid-session for a
failed star would be worse than the failure, and pressing again retries.

Session pages patch their in-memory card copies so the star stays lit when a card re-shows. The
multi-deck sessions (`all`, `folder`) keep a card on its queue item **and again** inside that item's
`deckCards` distractor pool, so both are patched — miss the second and the star flickers off.

## Filters

**Not a stat box.** The counter row (unlearned / learning / graduated / dormant) holds *graduation
states*, which partition the library — every card is exactly one of them. Starring cuts across that:
a card can be starred **and** graduated. Putting it in that row implied a mutual exclusivity that
doesn't exist, so it's a `StarFilterButton` (`components/StarFilterButton.tsx`) instead — a small ★
toggle that filters the card list.

| Surface | How |
|---|---|
| Deck page | ★ toggle beside the "Cards" heading; drives `?filter=starred` via the router |
| Library (pair view) and folder page | ★ toggle beside the search box; sets the local `activeFilter` |
| Practice | `{ type: 'starred' }` target source + its own tab. Never capped — starring is explicit — but still passes the drillable gate, so a starred phrase is reported as dropped rather than silently missing |

`'starred'` is part of each page's `FilterKey` union but has no counter entry, so the filtered-list
heading falls back to a literal `'Starred'` label rather than a config lookup.

## Bulk starring

The deck page's selection toolbar has a **★ Star / ★ Unstar** action beside Delete and Graduate.
One button does both: if any selected card is unstarred it stars the whole selection, otherwise it
clears them — so there's no mode toggle to get wrong. Writes are per card (there's no bulk RPC for
this yet); fine for a hand-made selection, worth revisiting if it's ever pointed at thousands.

---

## Error log

*(none yet)*

## Known gaps

- **No offline path.** `setStarred` writes straight to Supabase with no local-store branch or outbox
  entry, so starring while offline fails silently (the star reverts). Every other mid-session write
  has the same shape, so this matches — but it's the first thing to fix if starring becomes
  load-bearing offline.
- **Bulk starring is deck-page only.** The library and folder views have no multi-select, so there's
  no "star everything in this filter" there.
- **Not exposed to the card-editor agent**, so an agent can't star cards it thinks are worth
  revisiting.

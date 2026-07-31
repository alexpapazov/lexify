# Vocabulary Onboarding

**Status: built 2026-07-30. Migration `107_card_onboarding.sql` applied 2026-07-30 (archived).**

Bulk intake for words you already know. Paste a list (the 1000 most common Spanish words, a course
glossary), rate your confidence on each one, and the ones you know are scheduled straight into Due Now
instead of climbing the ladder. The point is to get Lexify's model of your memory to match reality
without studying vocabulary you've known for years.

Entry point: **Create → "Onboard vocabulary"**, the button beside *Preview deck*.

---

## 1. The flow

```
Create (paste list, deck name, languages)
  └─ Onboard vocabulary
       ├─ 1. accuracy check   AI flags likely-wrong cards; each must be resolved
       ├─ 2. duplicate drop   anything already in the pair's library is removed, silently
       ├─ 3. destination      folder picker + sync checkbox
       └─ 4. creates deck + cards + PENDING onboarding rows → /study/deck/onboard?deck=…
              └─ rate each card 1–4; every press persists immediately
```

Quitting mid-way is safe. The deck exists, the cards exist, and its page shows **"Finish onboarding
(N words)"** until the queue is empty.

### Stage 1 — accuracy check

`app/api/cards/verify/route.ts` + `lib/onboardVerify.ts`. Batches of **50**, **4 in flight**.

Flags three things: `mistranslation`, `ambiguous` (a gloss so broad the card can't be graded fairly),
and `language` (a side in the wrong language, usually swapped). It deliberately does NOT flag article
differences, gender tags, regional synonyms, or a reasonable narrowing — over-flagging would make a
1000-word list unusable. Each flag can carry a `suggestedFront`/`suggestedBack`.

This is a stricter gate than `/api/cards/generate`'s `languageWarning`, which only asks "is this text
in the right language" and says nothing about whether the translation is correct.

**Every flagged card must be explicitly resolved** (use the suggestion / keep as is / remove) before
rating starts. That's the deliberate friction: onboarding schedules a card up to 234 days out on one
self-rating, so a bad gloss would go unnoticed for most of a year.

If the whole verification fails, the learner is told and allowed to continue unverified rather than
being stranded. Individual failed batches are reported as "N cards couldn't be checked".

### Stage 2 — duplicate drop

**Front-only, and non-negotiable.** `partitionExistingFronts` in `lib/duplicates.ts`.

A word already in this pair's library is never shown for rating, because rating it would create a
second card for the same word with a competing self-assessed schedule. The key
(`normalizeFrontKey`) is: whitespace-collapsed, grammatical gender/number tags stripped, one leading
article stripped, lowercased. The gloss is ignored entirely — `el pan`/"bread" and `el pan`/"loaf" are
the same word.

It also de-dupes *within* the pasted list (frequency lists repeat lemmas; the AI-format pass can emit
the same front twice). Skipped words are counted and listed on request, and are **not** added to the
new deck — the deck contains only what was actually onboarded.

### Stage 3 — rating

`app/study/deck/onboard/page.tsx`. One card at a time, **both sides visible** — this isn't a test, the
learner is reporting what they already know. Keys **1–4** rate, **U** undoes the last one. Cards are
served in deck list order, in a centred `max-w-2xl` column.

Two card-level actions, both the same affordances the ladder already has:

- **Trash button** (card's top-right corner) — soft-deletes the card and removes its queue row, so it
  never reaches the deck. The queue row must be deleted explicitly: `softDelete` only sets
  `deleted_at`, so the FK cascade never fires and the deck would keep offering "Finish onboarding" for
  a card that can't appear. Removing (rather than skipping) the item shrinks the counter's total — a
  deleted card was never part of the work. **No confirmation and no undo.**
- **Double-click either side to edit** (`EditableAnswerText`). Persistence matches `LadderStudy`'s
  `onCardEdit`: editing the FRONT clears `audioGenerated`/`audioData`/`choices`, editing the back
  clears `choices`. Submitting an empty string deletes, per that component's contract. Note the
  editor is an `<input>`, so the 1–4/U key handler ignores keystrokes while it's open.

---

## 2. The bands

`engine/onboarding.ts`.

| Band | Meaning | Centre | Window | Difficulty |
|---|---|---|---|---|
| 1 | Don't know it | — | no CardState at all | — |
| 2 | Recognize it | 7 d | 3–11 d | `initialDifficulty(['hard'])` ≈ 6.3 |
| 3 | Know it | 30 d | 15–45 d | `initialDifficulty(['good'])` = 5.0 |
| 4 | Know it cold | 180 d | 126–234 d | `initialDifficulty(['easy'])` ≈ 3.4 |

**Band 1 writes nothing.** The card is left genuinely fresh — it counts as Unlearned on the deck page
and the ladder picks it up like any new card. The onboarding row is the only record that it was rated.

**The windows never overlap** (11 < 15, 45 < 126), so a higher band is never seen sooner than a lower
one. They widen with the interval: a day of slack matters at 7 days and doesn't at 180.

**Difficulty comes from the rating the learner would plausibly have given** had the card climbed the
ladder, reusing `initialDifficulty` so onboarded and ladder-graduated cards sit on one scale.

**Stability is derived from the day the card ACTUALLY landed on**, not the band's centre —
`stabilityForInterval(assignedDays, pairTargetRetention)`. So the stored state explains the card's own
due date, and the next interval grows from where it really sits. Retention *calibration* is
deliberately not applied at seed time: it corrects for measured review performance, and an onboarded
card has no reviews yet. The first real review picks it up normally.

## 3. Spreading

`seedOnboardLoad` / `claimSpreadDay` / `onboardDueIso` in `engine/density.ts`.

Neither existing helper fits: `smoothDueDate` costs a query per card, and `batchFastTrackDueDates` uses
one fixed window for a whole batch. Onboarding rates cards one at a time, each with its own band window.

So the rating screen seeds a **load map once at mount** (one `countDueByDateRange` over the whole
1–234 day horizon, counting everything already scheduled) and claims days from it locally as ratings
come in — batch-quality spreading at **zero queries per keystroke**.

`claimSpreadDay` picks the least-loaded day inside the band's window, pulled toward the centre by
`ONBOARD_CENTER_PULL` (normalised by half-window, so an edge day costs the same extra everywhere). In
practice: a handful of cards cluster near the centre, a 300-card band fills its window nearly evenly,
because real load quickly dominates the pull.

Due times are **mid-day UTC**, matching `batchFastTrackDueDates`. Due Now compares at date level
(`lib/dueStatus.ts`), so the time only needs to land on the intended calendar day.

## 4. What a rated card looks like

Bands 2–4 write **two `card_states` rows**, mirroring `LadderStudy.graduate()` exactly:

| Row | Columns set |
|---|---|
| `forward` | `dueAt`, `intervalDays`, `scheduledIntervalDays`, plus `smartDueAt`/`smartIntervalDays` **or** `typedDueAt`/`typedIntervalDays` depending on `activeProductionTrack` |
| `reverse` | `dueAt`, `intervalDays`, `scheduledIntervalDays`, `recallDueAt`, `recallIntervalDays` |

Each direction claims its **own** day from the shared load map, so a card's production and recognition
reviews don't land together.

Both rows carry `graduated: true`, `graduatedAt`, the band's difficulty/stability, and
**`acceleratedMode: 'bulk_known'`** — normal FSRS scheduling, but excluded from daily goals
(`isAutoGraduated`). Not `'import_known'`, which would put them on the accelerated-multiplier track.

`reps` stays 0 and `lastReviewedAt` stays null: no review happened, and a self-rating must not appear
in review analytics or fake an elapsed-time baseline.

When neither production track is enabled the typed lane is written anyway (same as ladder graduation) —
the card is ghosted until a track is turned on, which is the documented behaviour for disabled tracks.

## 5. Resuming — and why there's a table

`card_onboarding` (migration 107): `user_id, card_id, deck_id, band smallint null, created_at, rated_at`.

**`band IS NULL` = still to rate.** The table exists for one reason: a band-1 card writes no
`card_states` row, which is *exactly* what an un-rated card looks like. Without a marker there is no
way to tell "rated, don't know" from "never got to it", and a half-finished session could never be
resumed. Don't be tempted to infer the queue from missing card states.

`pendingCountsByDeck` drives the deck page banner. Reads are cached under the `onboarding:` prefix;
every write busts it.

**Online only.** The AI check needs the network, and the rating screen shows `OfflineUnavailable`
offline. There is no local-store path and nothing enqueues to the outbox.

## 6. Knock-on change: the AI-format path is now chunked

`INPUT_WORD_CAP` went **1000 → 5000** so a whole frequency list can be pasted. That exposed a latent
bug: `/api/cards/generate` answers in ONE model call and slices at `MAX_CANDIDATE_CARDS` (150), so a
1000-word list would have returned 150 cards and silently dropped the rest.

All generation now goes through **`lib/generateCards.ts`**, which chunks (75 lines per wordlist
request, ~600 words per extraction request, 3 in flight), drops exact repeats across chunks, and
reports `failedChunks` rather than losing the whole run to one failure. Both call sites use it
(`app/create/page.tsx`, `app/study/deck/add/page.tsx`).

**If you add another caller of `/api/cards/generate`, go through `generateCards`** — calling the route
directly with a large input truncates without an error.

---

## Error log

*(none yet — feature is new as of 2026-07-30)*

## Known gaps / possible follow-ups

- **Undo doesn't return the claimed day to the load map.** Undoing a rating deletes its card states but
  leaves the day marked as taken, so the next card is nudged away from a slot that's actually free.
  A rounding error across a session; tracking claims per card wasn't worth the complexity.
- **The trash button has no confirmation and no undo** — deliberate, to keep a 1000-card sitting fast.
  The card is soft-deleted, so it's recoverable in the database but not through any UI.
- **Editing a front doesn't re-run the duplicate check**, so it's possible to hand-edit a word into one
  that already exists in the library. The create-flow drop only ran on the original text.
- **The forward self-graded recall track (`recall_due_at` on the FORWARD row) isn't seeded**, matching
  `LadderStudy.graduate()`. A pair using that track gets it on the card's first production review.
- **No offline support** (§5).
- **The old "I already know some of these words (fast-track graduated review)" checkbox** in the preview
  stage still exists and does an overlapping thing at a flat 14-day spread. Left deliberately; worth
  retiring once onboarding has been used in anger.

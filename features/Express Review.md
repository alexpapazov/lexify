# Express Review — matching as a real review for reverse recognition

**Status (2026-08-27): v1 shipped.** Reverse-recognition (target → native) due cards can be cleared
through the matching game instead of a normal session. No migration.

## What it is

The Study dashboard's "Study all due → Self-graded · target → native" rows (All languages and each
pair) no longer navigate immediately: they expand a two-button choice, **⚡ Matching** or **Normal
review**. Matching opens `/study/express` (`routes.express({source, target})`), which runs the
existing `MatchingGame` (rounds of 8) over every due reverse row in scope — and here the game IS a
review:

- **A clean first-try match = a Good on that card's reverse row.** Full FSRS credit, identical to a
  self-graded Good in a session: the pair's `reverse_recall` target retention + calibration, the
  fuzz window, density smoothing, day-start snap, `reps + 1`, and a `review_events` row
  (`mode: 'recognition'`, `reviewDirection: 'reverse'`, `rating: 'good'`) so measured retention and
  analytics count it like any other recognition review.
- **A mismatch schedules NOTHING.** No lapse, no relearn loop, no event — the card (and the card
  whose meaning was wrongly chosen; both sides of a mix-up are marked) simply stays due, and the
  normal session makes the real judgement later. The finish screen's "Review the rest (N)" button
  goes straight to the normal reverse session, which by then contains exactly the missed cards.
- Credit is applied **per match, immediately**, so exiting mid-game keeps everything already
  cleared.

## Why only the reverse track

Matching word↔meaning is recognition evidence — precisely what the reverse row tests, and nothing
more. Production reviews (typed / smart / forward self-graded recall) test retrieval that a tile tap
cannot see, so they never come through here; giving them credit from a matching pass would grow
production intervals on the wrong kind of evidence. This design was the user's explicit call
(2026-08-27): full Good credit for clean matches, reverse only, chooser on the dashboard rows.

## The pool (`buildExpressPool`, lib/expressReview.ts — pure, tested)

Due reverse rows in scope, judged by `isCardStateDueNow` (the one definition of due: graduation,
the forward-row gate, per-direction dormancy, track enablement, turnover-aware dates), minus:

- **Relearn-loop rows** (`relearning` / `relearningStep > 0`) — they owe the loop two Goods, which
  a tile tap can't stand in for.
- **Cards whose front OR back reads identically to another pool card's** (after `displayText` +
  case-fold). Two identical tiles are a coin flip, and a coin flip must not earn scheduling credit —
  synonym-group members sharing a gloss are the common case. Skipped cards stay due for the normal
  session; the count is surfaced on the empty and finish screens.

## Pieces

| Piece | Where |
|---|---|
| Pool + credit | `lib/expressReview.ts` (`buildExpressPool`, `creditExpressMatch`) — 8 tests |
| Page | `app/study/express/page.tsx` (query params `?source=&target=`, static-export safe) |
| Route builder | `routes.express` in `lib/routes.ts` |
| Chooser | the sgReverse rows of the dashboard due picker (`app/study/page.tsx`, `expressPick` state) |
| Game hook | `MatchingGame`'s new optional `renderFinish` prop — replaces the practice result screen (which says "nothing was scheduled" — wrong here) and suppresses Play again (a replay would re-test just-credited cards) |

## Traps

- **A game must never be able to un-graduate a card.** Misses write nothing — do not "improve" this
  by logging an Again or a review event for a mismatch; the real review would then double-count the
  failure, and three tile mix-ups could send a card back to the ladder.
- `creditExpressMatch` mirrors the session pages' recall/reverse branch (`scheduleGraduatedFsrs` →
  fuzz → `smoothDueDate` → `snapDueAtToStartOfDay`; reverse rows mirror `recallDueAt` onto `dueAt`).
  If that branch's scheduling changes, change this too.
- The event write is fire-and-forget; the schedule upsert is not. A lost event costs one analytics
  row, never the credit.
- Express is **online-only** (`OfflineUnavailable`), like practice.

## Error log

| Date | Error | Fix |
|---|---|---|
| — | — | — |

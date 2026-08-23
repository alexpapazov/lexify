# Catch Up

**Status: rebuilt 2026-08-22. Migration `122_catchup_plans.sql` — apply before deploying.** Lives in
**Settings → Data, above Redistribute** (`components/settings/CatchUpPanel.tsx`).

Overdue cards all pile onto today. Pick a language — or one card type within it — and a date to be
level again by, and the backlog is dealt out across the days between.

---

## 1. It moves real due dates, and that is the whole point

The first build of this (commit `ab19733`) stored a target date and used it to **cap the session
queue**, leaving due dates untouched. That was wrong in practice: the plan was invisible. The
"Coming up" chart still showed 1,699 on today, the deck counts still said 1,693, and the app still
read as though you were drowning. The user's report was exactly right — *"I planned it but it did not
change when everything is due."*

Rewriting the dates makes every surface honest for free, instead of teaching each one about plans.

### Why this is safe

**FSRS measures elapsed time from `lastReviewedAt`, never from `dueAt`** (`engine/dueNow.ts` →
`reviewDueNow(state, grade, elapsedDays, …)`; the three session call sites all derive `elapsedDays`
from `state.lastReviewedAt`). So moving a due date changes **nothing** about difficulty or stability,
and the review — whenever it happens — is scored exactly as it would have been.

**Only past-due dates move.** `rescheduleOverdueTracks` refuses anything due today or later. A future
due date encodes an interval the scheduler actually chose; draining a backlog has no business
touching it. A card whose production is three weeks late but whose recognition is due next month has
only its production moved.

### What is stored, and what is not

The due dates themselves are the plan; the record in `profiles.catchup_plans` (migration `122`) is a
thin overlay that makes one *followable*:

```json
{ "bg|en:sgReverse": { "targetDate": "2026-09-05", "startedOn": "2026-08-22", "total": 81 } }
```

**All three fields are historical facts about the moment the plan was made, and none of them ever
changes.** How many are LEFT is never stored — it is recomputed from the live cards on every load.
That split is the discipline: store what happened, derive what is true now. Do not add a `remaining`
or `done` field.

> Migration `121` (deleted) added the same column with only `targetDate`. `122` is idempotent, and a
> record missing `startedOn`/`total` is discarded on read rather than shown with invented totals.

## 2. How the days are chosen

`assignBacklogDays()` in `lib/catchUp.ts` (pure, tested). Three things decide the layout:

**1. Existing load is levelled against, not ignored.** The days ahead already carry their own
arrivals — 186, 199, 249, 208 … in the reported case. The backlog is poured into the *gaps*: each
day's capacity is `level(existing + backlog) − existing[day]`, so a day already at 249 takes less
than one at 114, and a day already busier than the levelled total takes none at all. Spreading flat
on top would leave the chart as spiky as it started.

**2. Highest deferral damage lands earliest.** Deferral cost is **not monotonic** in how forgotten a
card is. Since `loss = R · (1 − 0.9^(d/S))`:

| | | |
|---|---|---|
| R ≈ 0.95, large S | rock solid | loses almost nothing by waiting |
| R ≈ 0.7, small S | **about to slip** | **loses a lot — review does the most work here** |
| R ≈ 0.05 | already gone | loses almost nothing more |

So the ranking peaks mid-band on its own. "Most overdue first" is the intuitive choice and the wrong
one — it front-loads precisely the cards already lost, which is the slowest, highest-lapse work.

**3. Deeply lapsed cards (`R < LAPSED_R = 0.30`) are spread evenly across *every* day**, not sorted
into a block. Relearning is the punishing work; concentrating it makes some days far harder than
their card count suggests. Fractional accumulation is used so a pool smaller than the window still
lands one per day instead of rounding to zero and dumping the remainder at the end.
`MAX_LAPSED_SHARE = 0.25` caps how much of a day may be relearning; when the pool is too big for
that, `lapsedCapped` is set rather than cards being dropped.

Verified against the reported backlog in `lib/__tests__/catchUpRealistic.test.ts`: 1,500 overdue
against real arrival numbers spreads to **under 400/day with no day above mean × 1.15**.

## 3. Pieces

| Piece | Where |
|---|---|
| Ranking, strata, day assignment, preview | `lib/catchUp.ts` (32 tests) |
| Due rows → per-scope pools; the write patch | `lib/catchUpPools.ts` (21 tests) |
| `overdue` vs `today` split, `daysOverdue` | `lib/dueStatus.ts` (`cardStateDueBucket`) |
| Measured review pace for the "~N min" | `lib/reviewPace.ts` (11 tests) |
| Plan record, debt detection, progress | `lib/catchUpPlan.ts` (22 tests) |
| Panel, picker, progress bars, Reassign | `components/settings/CatchUpPanel.tsx` |
| Realistic end-to-end sanity check | `lib/__tests__/catchUpRealistic.test.ts` |

### Scoping — two INDEPENDENT filters

**Language** and **card type** are separate facets, each with an "All" option, so every combination
is reachable: one language across all its types, one card type across every language, one specific
pair of the two, or the entire backlog at once.

The data behind this is a **flat list of overdue reviews** tagged `{ pairKey, type }`, and a selection
is simply a predicate over it. That matters: the first version grouped the data into a tree of scopes
keyed `bg|en` / `bg|en:typing`, which made "card type" silently language-scoped — there was no way to
express "all my typing cards" at all. Do not reintroduce the tree.

Pill counts are **faceted**: each language pill counts with the current type filter applied and vice
versa, so the numbers always describe what you would actually get.

The direction arrow only appears when a single language *and* a single type are selected — that is
the only case with one true direction. Otherwise the card-type filter uses the app's abstract
vocabulary (`native → target`), matching the "Study all due" popover's hints.

### `lib/reviewPace.ts` was extracted, not written

The recency-weighted per-bucket review pace already existed inside
`components/analytics/PresentSnapshot.tsx`. It was lifted into `lib/` unchanged and PresentSnapshot
imports it, so the "~N min" in the picker and the "~N min" on the Present tab cannot diverge. The
panel's own query is a capped `limit(1000)` single request, not a 30-day window — 30 days of
`review_events` is ~14k rows over several serial pages, the regression the 2026-07-27 perf pass
removed. The 7-day recency half-life means the newest reviews dominate anyway.

## 4. One catch-up per card

A card can never be dealt a date by two plans. Two things enforce it, and they are separate on
purpose:

**Structural.** Spreading moves a card's due date to today or later, and `rescheduleOverdueTracks`
refuses anything not strictly overdue. So the moment a plan claims a card it drops out of every
later plan's backlog — including one whose selection overlaps (spread "Greek", then spread "all
languages", and the Greek cards stay exactly where the first plan put them).

This is also why **all** of a row's overdue tracks move together. A forward row can have production
and recall both overdue; leaving one behind would keep the row reading as overdue forever, so no plan
could ever clear it. Covered by `describe('one plan per card')` in `catchUpPools.test.ts`.

**Liveness re-check at write time.** The selection is computed at load, which may be minutes old —
another tab, an earlier spread this session, or reviews done in between. Before writing, the panel
re-reads the rows and re-judges each through `rescheduleOverdueTracks`; anything already claimed is
skipped and reported ("N were left alone — already on a catch-up schedule"). Same pattern as
`planDedupeDeletions` re-checking liveness at apply time, and for the same reason: a stale snapshot
must never authorise a write.

Note what this does **not** prevent, deliberately: plans with different windows coexisting. Spread
Greek over 30 days and everything else over 7, and each card keeps the date its own plan gave it.
That is one plan per card, not one plan overall.

## 5. Progress, and Reassign

### Recognising a claimed card without a marker column

`CardState.scheduledIntervalDays` is *defined* as the calendar gap between `lastReviewedAt` and
`dueAt` after smoothing. So an untouched card has `due − lastReviewed ≈ scheduledIntervalDays`, while
a card catch-up pushed out — without a review — has a strictly larger gap. That is
`isCarryingDebt()`, and combined with "falls inside the plan's window" it identifies exactly the
cards a plan is still owed. No new column, nothing to keep in sync.

Both halves are needed. The window alone would sweep in every normally-arriving review that happens
to land in the same fortnight (186/day in the reported case); the debt check alone would count cards
pushed by an older, longer plan.

Tolerance is `interval × 1.05 + 1 day`, because **Redistribute moves due dates within the ±5% FSRS
fuzz window without touching `scheduledIntervalDays`** — a redistributed card must not read as
planned.

Reviewing a card rewrites `lastReviewedAt` and `scheduledIntervalDays` together, so it stops carrying
debt the instant it is done. That is what moves the bar.

### Reassign

Re-deals the cards a plan still owes across its remaining days, levelled against current load. Its
one distinguishing argument is `replanThrough`: tracks already sitting inside the window may move,
**but only for rows carrying debt**. That check lives inside `rescheduleOverdueTracks`, not in the
caller — "unplanned cards stay unchanged" is a guarantee, and a guarantee the caller has to remember
is not a guarantee. Five tests in `catchUpPools.test.ts` pin it, including the case that matters:
an unplanned card sitting in the window is refused.

Reassign also subtracts the plan's own cards from the levelling load before re-dealing, or they would
count as immovable congestion and the re-deal would pile everything into whatever days looked free.

### Overlapping plans

A language plan and a card-type plan inside it claim some of the same cards, so two bars would
double-count. `conflictingScopes()` makes creating either one replace the other.

## 6. Traps

- **Write the lane column, not just `due_at`.** Queue building reads `smart_due_at ?? typed_due_at ??
  due_at`; several counts still read `due_at`. `rescheduleOverdueTracks` writes whichever lane holds
  the schedule *and* keeps `due_at` in step — same rule Redistribute follows.
- **Reverse rows schedule on `recall_due_at`**, on their own row, gated on the FORWARD row being
  graduated. A legacy reverse row on `due_at` gets both written, or the stale column keeps reading as
  due through the fallback.
- **The time-of-day is preserved**; only the calendar day moves. Due dates are snapped to the start of
  the study day, so the time part carries the turnover offset.
- **The write is chunked at 200** in the panel. `stateRepo.upsertBatch` sends one request, and a
  language-wide backlog is several hundred full rows. Chunking locally leaves Redistribute alone.
- **`dueStatus.ts` now has one shared gate.** `activeDueDates()` backs `isCardStateDueNow`,
  `cardStateDueBucket` and `daysOverdue`. That file exists because surfaces drifted; don't add a
  reader with its own copy.
- **The row label's arrow is per CARD TYPE, not per pair.** A pair key is `${learned}|${native}`, but
  typing and self-graded-forward are *production* — prompted in your native language — so a Bulgarian
  typing scope must read "English → Bulgarian". Use `scopeDirection()`; a whole-language scope gets
  `↔` because it genuinely covers both. This mirrors the `n2t` flag in the dashboard's "Study all due"
  popover — keep the two in step.
- **`Pill` is declared at module scope.** A component defined inside a render is a new component
  type every render, so React remounts its entire subtree on each keystroke.
- **A forward and a reverse review of the same card are separate items** (`candidateKey` is
  `cardId:direction`). Collapsing them undercounts the backlog.

## 7. Error log

- **2026-08-22 — the plan was invisible.** Built first as a session-queue cap with a stored target
  date; every due count and the forecast chart were unchanged, so nothing appeared to happen. Cause
  was a wrong premise on my part: I had assumed rewriting due dates would corrupt the FSRS memory
  model. It does not — elapsed time comes from `lastReviewedAt`. Rebuilt as a date-rewriting action.
- **2026-08-22 — row labels pointed the wrong way.** Every row rendered `source → target` off the
  pair key, so a typing scope read "Bulgarian → English" when the prompt is English and you type
  Bulgarian. The subtitle's abstract "native → target" then contradicted the concrete arrow beside
  it. Fixed with `scopeDirection()` (prompt language first, `↔` for a whole-language scope) and by
  dropping the abstract direction from the subtitle, so direction is stated in exactly one place.

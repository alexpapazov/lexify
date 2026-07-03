# Due Now — Spaced Repetition Scheduler

This document covers how Lexify schedules **graduated cards** — cards that have completed the learning pipeline and now live in long-term review. Everything here lives in `engine/scheduler.ts` and the post-graduation branch of `engine/pipeline.ts`. For how a card reaches graduation in the first place, see `features/Learning Pipeline.md`.

---

## What "Due Now" means

A graduated card has a `dueAt` timestamp. It appears in the "Due Now" queue when `dueAt <= now`. The study session pages (`app/study/[deckId]/session/page.tsx` and the other two session pages) filter the card list on this condition.

Post-graduation reviews always show **English (the basis language / `card.back`) as the prompt** and ask the learner to **produce Spanish (the target / `card.front`)**. This is overridden in all three session pages:

```ts
const reviewPromptSide: CardSide = state.graduated ? 'back' : step.promptSide
const reviewAnswerSide: CardSide = state.graduated ? 'front' : step.answerSide
```

---

## Core scheduling: interval × multiplier

Each correct rating multiplies the current interval by a rating-dependent factor. The new interval becomes the base for the next review.

| Rating | Ideal multiplier | Full range (before decay) |
|--------|-----------------|--------------------------|
| Hard   | 1.2×            | 1.1× – 1.3×              |
| Good   | 2.25×           | 2.0× – 2.5×              |
| Easy   | 3.5×            | 3.0× – 4.0×              |

The min/max range exists for **review-density smoothing** (`engine/density.ts`), which may nudge `dueAt` slightly within that window to avoid many cards piling up on the same day. The ideal value is always used for the actual interval.

### Multiplier decay

Multipliers shrink toward a floor as the current interval grows:

```
effective = 1 + (base − 1) / (1 + currentInterval / 90)
```

At a 90-day interval the "above-1" portion is halved. Floors:

| Rating | Floor  |
|--------|--------|
| Hard   | 1.0×   |
| Good   | 1.15×  |
| Easy   | 1.25×  |

Hard cap: **1,825 days (~5 years)**.

### First interval after graduation

When a card has no prior interval (just graduated or re-graduated after being sent back to the pipeline):

| Graduating rating | First interval |
|-------------------|---------------|
| Again             | 1 day         |
| Hard              | 1 day         |
| Good              | 3 days        |
| Easy              | 7 days        |

---

## Review timing: elective vs. due

Every review is classified based on how early the learner is:

```
progress = elapsed_since_last_review / scheduled_interval_days
```

| Progress   | Classification     | Behaviour |
|------------|--------------------|-----------|
| < 0.30     | Very early         | Correct answer is a **no-op** — `dueAt`, `intervalDays`, and `lastReviewedAt` are all left unchanged |
| 0.30 – 1.0 | Elective (early)   | Interval grows but is **blended toward no-change** proportionally to `progress` |
| ≥ 1.0      | Due / overdue      | Normal multiplication; overdue gap is rewarded |

#### Early blend formula

```
newInterval = currentInterval × (1 + progress × (multiplier − 1))
```

At `progress = 0.5` with a 2.25× multiplier the effective multiplier is 1.625×. The closer to the due date, the more full credit the review earns.

#### Overdue reward

When due or overdue, the base for multiplication is `max(elapsed, currentInterval)`. If the learner waited longer than scheduled they get credit for the longer real-world gap.

---

## Wrong answers: the 10-minute relearn loop

A `rating = 'again'` on a graduated card does **not** immediately shorten the long-term interval. Instead:

1. A **shortened "pending" interval** is computed and stored in `pendingIntervalDays`
2. `dueAt` is set to **10 minutes from now** (`relearningStep = 1`)
3. `intervalDays` is left at its pre-lapse value

On the 10-minute retry:
- **Correct** → the pending interval is multiplied by the Hard/Good/Easy multiplier (same ranges as normal scheduling), floored at 1 day (Hard/Good) or 2 days (Easy), and used as the new interval. `relearningStep` resets to 0, card returns to normal schedule.
- **Wrong again** → `pendingIntervalDays` is reduced by another 40% (×0.60), another 10-minute retry is scheduled, `relearningStep` increments.

### How the pending interval is computed

Each "Again" press reduces the pending interval by a flat **40%** (`×0.60`), compounding with each additional failure. Timing (early vs. due) and answer severity (`wrongSeverity`) do **not** affect the pending interval — they are tracked by `grading.ts` but the scheduler ignores them for this purpose.

```
First lapse:            pendingInterval = currentInterval × 0.60
Second lapse (in loop): pendingInterval = previousPending × 0.60
Third lapse, etc.:      compounds further
```

There is **no floor** on `pendingIntervalDays` itself — it can fall below 1 day for very short intervals. The output floor (1 day for Hard/Good, 2 days for Easy) is only enforced when the relearn loop exits on a correct answer.

Constant in `engine/scheduler.ts`: `AGAIN_REDUCTION = 0.60`.

---

## Lapse clustering: back to the learning pipeline

Three or more "Again" ratings within **24 hours** of each other triggers a full return to the learning pipeline (`graduated = false`, `currentStepOrder = 0`). This applies whether the lapses happen during normal graduated review or while already in the 10-minute relearn loop.

The cluster counter (`lapseClusterCount`) resets to 1 each time a lapse falls outside the 24-hour window from `lastLapseAt`.

---

## Production mode: typed vs. self-graded

After graduating, each review is presented either as **typed production** (type the answer, auto-graded) or **self-graded** (recall mentally, then rate Again/Hard/Good/Easy yourself). The decision is made by `decideProductionMode()` in `engine/productionMode.ts`.

### Forced typed (highest priority, overrides everything)

- `forcedTypedRemaining > 0`:
  - Spelling / accent / gender / article mistake in a typed review → 3 forced typed reviews
  - Self-graded "Again" → 1 forced typed review
  - Card sent back to pipeline by lapse cluster → 1 forced typed review on re-graduation
- Last rating was **Hard** → next review is typed
- No typed review in the last **90 days** → forced back to typed

### Mandatory typed window post-graduation

Typing is mandatory until **all three** of these are satisfied:
1. ≥ 14 days since graduation
2. ≥ 4 typed reviews completed
3. Recent typed accuracy ≥ 85% (rolling window of last 20 typed reviews)

### Probabilistic typed mode

Once out of the mandatory window and no force condition applies:

| Recent typed accuracy | Probability of typed |
|----------------------|----------------------|
| < 70%                | 100%                 |
| 70% – 84%            | 70%                  |
| 85% – 94%            | 35%                  |
| ≥ 95%                | 15%                  |

---

## Relevant CardState fields

| Field | Meaning |
|-------|---------|
| `graduated` | True once the card has completed the learning pipeline |
| `dueAt` | ISO timestamp when the card is next due |
| `intervalDays` | The "ideal" (continuous) memory interval — base for next multiplication |
| `scheduledIntervalDays` | Actual calendar gap scheduled (used for progress / timing classification) |
| `ease` | 1.3–3.0; Hard −0.15, Easy +0.15, Good unchanged. Persisted but not currently used by multiplier logic |
| `reps` | Count of successful graduated reviews (Hard does not increment) |
| `lapses` | Total "Again" ratings post-graduation |
| `relearningStep` | 0 = not in relearn loop; ≥1 = failed retries since the lapse |
| `pendingIntervalDays` | Shortened interval to apply when the relearn loop exits successfully |
| `lapseClusterCount` | How many lapses have occurred within the current 24h window |
| `lastLapseAt` | Timestamp of most recent lapse (for cluster window detection) |
| `typedAccuracyWindow` | Rolling array of 1/0 for last 20 typed reviews |
| `typedReviewCount` | Total typed reviews ever |
| `lastTypedReviewAt` | ISO timestamp of last typed review |
| `forcedTypedRemaining` | Countdown of reviews where typing is forced |
| `graduatedAt` | ISO timestamp of most recent graduation |
| `intervalHistory` | Last 50 `scheduledIntervalDays` values |
| `lastRating` | Most recent rating (used to detect Hard → force typed) |

---

## Fast-tracked cards and the due-now queue

Cards that bypassed the learning pipeline via fast-track enter the due-now queue directly. Their first `dueAt` is set 30 days out (initial `intervalDays = 30`), spread across the next 14 days using the load-balancing algorithm described in `features/Learning Pipeline.md`.

From the scheduler's perspective, a fast-tracked card is identical to a normally-graduated card. The only difference is that `graduatedAt` and `introducedDate` are both set to the upload date, and `reps = 0` (no prior reviews), so the mandatory typed window applies immediately (≥ 14 days since graduation, ≥ 4 typed reviews, ≥ 85% accuracy before self-graded mode becomes available).

---

## Hint button (Due Now only)

On a **genuinely-due graduated review** (not the pipeline, not early/elective — gated by `state.graduated && classifyReviewMode(state) === 'due'`), a **Hint** button appears next to Check (typed) / Show answer (self-graded). It reveals the start of the answer and dampens the interval growth on a *correct* rating — but never auto-penalizes: pressing Again after a hint schedules exactly like a normal Again.

- **Reveal** (`lib/hints.ts: hintPlan`): alphabetic (Latin/Cyrillic/Greek) → first letter, then first two letters; Korean (Hangul) → first syllable's initial+medial (안→아), then the full first syllable (안→안). Letters count from the first *content* word (a leading article like "el codo" is kept in the autopopulated text so grading matches, but the revealed letter is the content word's). Typed mode autopopulates the input; self-graded shows the prefix as text. Never reveals the whole answer (1-char words / single-syllable-no-final Korean get no hint).
- **Penalty** (`lib/hints.ts: hintGrowthFactor`, applied in `engine/scheduler.ts` via `ScheduleContext.hintGrowthFactor` as `1 + (multiplier − 1) × k`): press 1 → k=0.65, press 2 → k=0.40; a "short word" where only one press is possible (single-syllable Korean, ≤2-char word) → k=0.35. `again` is unaffected. Applies on top of the normal or accelerated range.
- **Tracking**: `review_events.hint_level` (migration 064; `ReviewEvent.hintLevel`) records 0/1/2; shown as a "Hint" badge in the card info (ℹ) menu's review history.
- Not offered on synonym-chain Due Now cards (`SynonymDueNowMode`) or any pipeline step.

---

## Error log

| Date | Error | Fix |
|------|-------|-----|
| 2026-06-22 | Rating buttons auto-advanced on Enter after submitting a typed answer — `autoFocus={rating === suggestedRating}` caused the suggested button to steal keyboard focus immediately on render, so the keyup from the original Enter fired it | Removed `autoFocus` and the `↵` indicator from `RatingButtons.tsx` entirely |
| 2026-06-28 | "?" button did not appear on due-now cards — `!gradedReview` guard in `TypingMode.tsx` suppressed the button for graduated cards; additionally `onIDontKnow` and `onAdvance` were not passed to the post-graduation `TypingMode` usage in any of the three session pages | Removed `!gradedReview` from the "?" button condition; added `onIDontKnow={handleIDontKnow}` and `onAdvance={() => setIndex(i => i + 1)}` to all three session pages' graduated TypingMode |
| 2026-06-28 | Continue button stuck after "?" retype on due-now cards — the revealed-retype Continue calls `onAdvance?.()` but `onAdvance` was undefined in the post-graduation TypingMode, making it a no-op | Same fix as above: wiring `onAdvance` to all three session pages |

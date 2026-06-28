# Learning Pipeline

This document covers how a card moves from **unlearned to graduated** — the structured teaching phase that runs before long-term spaced repetition begins. Everything here lives in `engine/pipeline.ts` and the pre-graduation branch of `progressAfterReview()`. For what happens after graduation, see `features/Due Now.md`.

---

## Overview

Every new card starts at step 0 of the pipeline. It works through each step in order, earning correct answers until it meets each step's requirement, then advancing to the next. When it completes the final step it **graduates** and receives its first long-term interval from the scheduler.

The pipeline is stored in the database (`pipelines` / `pipeline_steps` tables), not hardcoded. The engine finds the next step generically:

```ts
sortedSteps.find(s => s.stepOrder > state.currentStepOrder)
```

Adding a new step is a migration insert — no engine code changes needed.

---

## The default pipeline (5 steps)

| Step | Type | Prompt → Answer | Required correct |
|------|------|-----------------|-----------------|
| 0 | Recognition (multiple choice) | Spanish → pick English | 1 |
| 1 | Recognition (multiple choice) | English → pick Spanish | 1 |
| 2 | Typing | English shown → type Spanish | **2 in a row** |
| 3 | Typing | Spanish shown → type English | 1 |
| 4 | Recognition (multiple choice) | Spanish → pick English | 1 |

Pipeline ID `00000000-0000-0000-0000-000000000001`.

---

## What counts as correct in the pipeline

`hard` and `again` never advance the step counter, even if the underlying answer was right. Only `good` or `easy` with `wasCorrect = true` counts:

```ts
const countAsCorrect = wasCorrect && rating !== 'again' && rating !== 'hard'
```

- Correct + `good` or `easy` → `correctInStep` increments
- Anything else → `correctInStep` resets to 0

---

## Advancing through steps

When `correctInStep` reaches `requiredCorrect` for the current step:

- **Next step exists** → move to it, reset `correctInStep` to 0
- **No next step** → **graduate**: call `scheduleNext()` to set `graduated = true`, then the session page overrides `dueAt` and `intervalDays` based on the learner's typing error count for that card (see below)

### Graduation interval (struggle-based)

The first long-term interval is determined by a **struggle counter** accumulated during the pipeline run for that card. The counter increments on:

- Any **wrong answer** on any step (typing or recognition/multiple-choice)
- Any **"?" press** on any step
- Any **Repeat press** (requesting extra practice, even after a correct answer)

| Struggles | Interval range | Ideal |
|-----------|---------------|-------|
| 0         | 4–6 days      | 5     |
| 1         | 3–4 days      | 3     |
| 2         | 2–3 days      | 2     |
| 3         | 1–2 days      | 1     |
| 4+        | 1 day         | 1     |

The ideal is `Math.floor((min + max) / 2)`. When the range spans more than one day, the density smoother (`engine/density.ts: smoothDueDate`) picks the least-loaded day within the range. The day-start snap (`lib/dates.ts: snapDueAtToStartOfDay`) then aligns it to the user's turnover hour so all graduating cards surface simultaneously.

The struggle counter (`pipelineTypingErrorsRef`) is per-card, lives only in the session component's refs (never persisted), and is cleared when the card graduates.

Logic lives in `engine/scheduler.ts: graduationIntervalRange()` and is applied in all three session pages (`handleAnswer` graduation branch).

---

## The same-day window (stages 3–5)

The final three steps of the pipeline (steps 2, 3, 4 in the default 5-step pipeline) must all be completed **on the same calendar day**. The window is computed generically:

```ts
const windowStartStep = sortedSteps[Math.max(0, sortedSteps.length - 3)]
```

**Tracking:** `CardState.stage3EnteredDate` (a `YYYY-MM-DD` string) is set to today when the card first enters the window's first step.

**Rule:** If the card completes a step that is *inside* the window but *after* the window's first step, and the current date differs from `stage3EnteredDate`, the card is sent back to the window's first step and the date resets to today. Cards with `stage3EnteredDate = null` (not yet in the window) skip this check entirely — backward compatible.

**Why:** Forces the learner to complete the hardest steps (both typing directions + final recognition) without a night's sleep gap in between. If they stop partway through, they redo the whole window the next day.

---

## Typing mistake streak → redo recognition steps

Repeatedly failing typing steps triggers a more severe reset than just the current step:

- Every **3 consecutive wrong** typing answers = 1 "fail cycle" (`typingMistakeStreak` resets to 0)
- On the **3rd fail cycle** (9 total wrong-in-a-row) → card is sent back to `sortedSteps[0]` (step 0), the first recognition step, forcing the learner to redo both multiple-choice directions before resuming typing

Tracked via `CardState.typingMistakeStreak` (0–2 before cycling) and `CardState.typingFailCycles` (0–2 before triggering). A correct typing answer immediately resets `typingMistakeStreak` to 0.

This rule composes independently with the same-day window — a redo-to-step-0 does not reset `stage3EnteredDate`.

---

## The "I don't know" (?) button

Available during **all** pre-graduation steps — both recognition (multiple choice) and typing. Pressing `?`:

- Reveals the correct answer in the card without requiring the learner to submit
- Applies **3× `again`** through `progressAfterReview()` (heavy pipeline penalty)
- Increments `CardState.iDontKnowCount`
- Re-queues the card 4 slots later in the session queue so it resurfaces shortly

For graduated/due cards, only **1× `again`** is applied (same as a regular wrong answer — the triple penalty is too harsh for long-term review).

The triple penalty for pipeline cards is intentional — not knowing the card at all is worse than guessing wrong once.

---

## Repeat button

A **Repeat** button appears after answering a pipeline step correctly. Pressing it:

- Credits the current step as `'good'` (so progress is saved)
- Re-inserts a copy of the card **6 slots later** in the session queue so the learner can immediately practice the step again
- **Increments the graduation struggle counter** by 1 — choosing to repeat signals the learner isn't fully confident, so it contributes to a shorter first interval at graduation

This is opt-in — the learner only sees it if they want extra practice on a card they just got right.

---

## Session queue building

Before the session starts, the session page builds a queue of cards to study today. For the learning (non-graduated) subset:

- Cards with no `CardState` are treated as new ("unlearned") via `initialCardState()`
- Cards with `state.graduated = false` are "learning" — in the pipeline but not yet graduated
- A daily new-card budget limits how many unlearned cards are introduced per session (configurable via deck preferences)

Cards in the learning pipeline are always included in the regular queue regardless of `dueAt` — they don't have a due date until they graduate.

### Elective and category sessions

In addition to the regular new+due queue, learners can study outside the daily schedule:

- **Category sessions** (`?category=new|learning|graduated|due`): study only cards from one category. Triggered from the deck detail page's "Study [Category]" button or the filtered card list button. Skips the daily new-card budget entirely.
- **Elective picker**: when the normal queue is empty, learners can opt into studying unlearned cards (beyond the daily budget) or early-review of graduated cards. Shown as a checkbox picker before the session starts (deck session only).
- **Batch cap**: elective/category sessions are capped at `electiveSessionLimit` cards per batch (default 20, 0 = no cap). Controlled via deck preferences. On the deck session page, a "Study ahead (N more)" button appears after each batch to continue.

---

## Fast-track (skip the pipeline)

Fast-tracking marks a card as **already graduated** at upload time, bypassing the learning pipeline entirely. Use this for words you already know.

### How it works

`fastTrackCardState()` in `engine/pipeline.ts` creates a `CardState` with:
- `graduated = true`
- `currentStepOrder` set to the last pipeline step
- `dueAt` assigned by `batchFastTrackDueDates()` (spread over up to 14 days)
- `intervalDays = 30` — first review interval is 30 days out

### Due date spreading (14-day window)

Fast-tracked cards are spread across the next **14 days** to prevent review pile-ups. `batchFastTrackDueDates()` in `engine/density.ts`:

1. Looks up how many graduated cards are already due on each of the next 14 days
2. Uses a greedy algorithm to assign each new card to the **least-loaded day**
3. The window is `Math.min(14, count)` — smaller batches get fewer days (e.g. 3 cards → 3 days)

The same spreading logic runs server-side in `lib/syncProcessor.ts` via `batchFastTrackDueDatesServer()` when synced cards are fast-tracked.

**Important:** Never revert to the old formula `Math.min(30, Math.ceil(count / 3))` — it under-spreads small batches.

### Triggering fast-track

1. **Upload page**: checking "I already know some of these words" checkbox, then using the per-card checkboxes to select which cards to fast-track. All are pre-checked; uncheck cards you want to learn normally.
2. **Sync**: when uploading with "Apply fast-track to synced cards too → Yes, for new synced cards", only the synced counterparts of the checked source cards are fast-tracked (not all synced cards). This is controlled by `fastTrackSyncMode: 'new_only'` and `fastTrackSourceCardIds` in the sync payload.

---

## Initial CardState

When a card is first studied, `initialCardState()` in `pipeline.ts` creates:

```ts
{
  currentStepOrder: 0,
  correctInStep:    0,
  graduated:        false,
  dueAt:            null,
  intervalDays:     0,
  ease:             2.5,
  reps:             0,
  lapses:           0,
  typingMistakeStreak: 0,
  typingFailCycles:    0,
  stage3EnteredDate:   null,
  iDontKnowCount:      0,
  // ... all other fields at zero/null defaults
}
```

---

## Relevant CardState fields

| Field | Meaning |
|-------|---------|
| `graduated` | False while in the pipeline; set to true on graduation |
| `currentStepOrder` | Which pipeline step the card is currently on |
| `correctInStep` | Consecutive correct answers accumulated in the current step |
| `typingMistakeStreak` | Consecutive wrong typing answers (0–2 before a cycle fires) |
| `typingFailCycles` | How many full 3-streak cycles have completed (0–2 before redo-to-step-0 fires) |
| `stage3EnteredDate` | YYYY-MM-DD date the same-day window was entered; null if not yet reached |
| `iDontKnowCount` | Cumulative `?` presses for this card (lifetime count) |
| `introducedDate` | Date the card was first studied (YYYY-MM-DD) |
| `lastRating` | Most recent rating |
| `lastReviewedAt` | ISO timestamp of most recent review |

---

## Error log

| Date | Error | Fix |
|------|-------|-----|
| 2026-06-20 | Pre-graduation typing cards auto-advanced after a single Enter press — pressing Enter called `check()`, React committed the render showing the Continue button with `autoFocus`, then the browser fired `keypress` on the newly focused button | Removed `autoFocus` from the Continue button in `TypingMode.tsx`; replaced with `useRef` + `useEffect` + `setTimeout(100ms)` so focus is applied well after the key event cycle ends |
| 2026-06-24 | Sync fast-track applied to all synced cards regardless of which source cards were checked — `fastTrackSyncMode: 'new_only'` fast-tracked every new stub | Added `fastTrackSourceCardIds: string[]` to `SyncPayload`; `syncProcessor.ts` now filters `createdCards` to only those whose source card ID is in that set |
| 2026-06-28 | Editing the correct answer (double-click) mid-session caused all choices to appear wrong — `choices` state was only rebuilt on `card.id` change, so after editing `card.back` from e.g. "sick (feminine)" to "sick", `displayCorrect` updated but the choices array still contained the old string; no option matched | In `MultipleChoiceMode.tsx: commitEditChoice()`, when `isCorrect=true`, replaced the old correct answer text in the `choices` array with the new trimmed value before resetting `selected` |

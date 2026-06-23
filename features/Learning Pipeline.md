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
- **No next step** → **graduate**: call `scheduleNext()` for the first long-term interval, set `graduated = true`

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

Available during pre-graduation recognition (multiple choice) steps. Pressing `?`:

- Reveals the correct answer in the card
- Applies **3× `again`** through `progressAfterReview()` (heavy pipeline penalty; graduated cards only get 1× `again`)
- Increments `CardState.iDontKnowCount`

The triple penalty is intentional — it represents not knowing the card at all, which is worse than guessing wrong once.

---

## Session queue building

Before the session starts, the session page builds a queue of cards to study today. For the learning (non-graduated) subset:

- Cards with no `CardState` are treated as new ("unlearned") via `initialCardState()`
- Cards with `state.graduated = false` are "learning" — in the pipeline but not yet graduated
- A daily new-card budget limits how many unlearned cards are introduced per session (configurable via deck preferences)

Cards in the learning pipeline are always included in the regular queue regardless of `dueAt` — they don't have a due date until they graduate.

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

# Phase 2 — Dual Intervals & Reverse Direction (Chunks 3 + 4)

Read this file in full before touching a single file. Phase 1 must be complete and all three migrations (054, 055, 056) applied in Supabase before starting here.

## What this phase delivers

- Session queue building checks both `typed_due_at` and `recall_due_at` in addition to the legacy `dueAt`
- Phase 1 mandatory typed window: a card must get 3 consecutive correct typed reviews before the recall track is introduced
- Phase 2 recall track activation: once Phase 1 is satisfied, `recall_interval_days` and `recall_due_at` are written and the card surfaces for recall reviews
- One-way typed→recall early review credit
- Reverse direction CardState rows: same `cardId`, `review_direction = 'reverse'`
- At graduation (new cards): reverse row created automatically, spaced ~2–3 days before the forward typed interval
- Existing graduated cards: reverse row created on-demand at their first due-date review post-migration
- `handleAnswer` routes correctly based on which track (typed or recall) triggered the review

**Visible behavior change:** Graduated cards now have two review types. Recall reviews surface as self-graded flashcard mode (show front, rate yourself). Reverse reviews surface as recognition multiple-choice (Spanish shown, pick English). Forward typed reviews continue unchanged.

---

## Conceptual model to keep in mind

A single card has up to **three** active CardState rows:

| Row | `review_direction` | tracks | notes |
|---|---|---|---|
| Forward | `'forward'` | `typed_due_at` + `recall_due_at` | both tracks |
| Reverse | `'reverse'` | `recall_due_at` only | never typed |

"Phase 1" and "Phase 2" apply only to the forward row:
- **Phase 1**: `typed_due_at` is set, `recall_due_at` is null. Card surfaces for typed reviews only. Ends when the card has 3 consecutive correct typed reviews post-graduation.
- **Phase 2**: Both `typed_due_at` and `recall_due_at` are set. Card surfaces for both independently.

The legacy `dueAt` / `intervalDays` fields on the forward row continue to be written and used as-is. Phase 1/2 tracks are additive, not a replacement.

---

## Session queue building changes

All three session pages have a `load()` function that builds the queue. The current logic for graduated cards checks `state.dueAt <= now`. This needs to be extended.

### Step 1: Define a queue item type extension

In each session page file, the `SessionCard` type (or equivalent inline object) needs to know which track triggered the review:

```typescript
// Add to the SessionCard type or the inline queue item:
reviewTrack?: 'typed' | 'recall' | 'legacy'
// 'typed'  = typed_due_at triggered this
// 'recall' = recall_due_at triggered this
// 'legacy' = dueAt triggered this (Phase 1 cards or cards not yet in Phase 2)
```

### Step 2: Extended due check

When iterating over graduated card states to build the due queue, replace the current:

```typescript
// OLD:
if (state.graduated && state.dueAt && new Date(state.dueAt) <= now) { ... }
```

With:

```typescript
// NEW:
const isLegacyDue   = !state.typedDueAt && state.dueAt && new Date(state.dueAt) <= now
const isTypedDue    = state.typedDueAt  && new Date(state.typedDueAt) <= now
const isRecallDue   = state.recallDueAt && new Date(state.recallDueAt) <= now

// Add typed track item
if (isTypedDue) {
  queue.push({ ...card, state, reviewTrack: 'typed' })
}
// Add recall track item (SEPARATE queue entry — same card, different track)
if (isRecallDue) {
  queue.push({ ...card, state, reviewTrack: 'recall' })
}
// Legacy path for cards not yet in Phase 2
if (isLegacyDue && !state.typedDueAt) {
  queue.push({ ...card, state, reviewTrack: 'legacy' })
}
```

Note: a single card can contribute TWO items to the queue if both tracks are due at the same time. This is intentional — they get separate review events.

### Step 3: Exclude reverse-direction states from the main forward queue

Reverse CardState rows (`review_direction = 'reverse'`) are fetched separately and added as recall-only items. Do NOT load them through the same path as forward states.

```typescript
// Separate fetch for reverse states:
const reverseStates = allCardStates.filter(s => s.reviewDirection === 'reverse')
for (const state of reverseStates) {
  const isReverseDue = state.recallDueAt && new Date(state.recallDueAt) <= now
  if (isReverseDue) {
    const card = cardMap.get(state.cardId)
    if (card) queue.push({ ...card, state, reviewTrack: 'recall', isReverse: true })
  }
}
```

---

## Handling reviews by track

In `handleAnswer` (and `handleIDontKnow`), the review track determines which interval gets updated.

### Legacy track (no Phase 2 yet)

Behaves exactly as today — updates `dueAt`, `intervalDays`, `scheduledIntervalDays`. No changes to `typedDueAt`/`recallDueAt` (they remain null). Also check Phase 1 completion after every correct typed review (see "Phase 1 completion check" below).

### Typed track (`reviewTrack === 'typed'`)

After `scheduleNext()`:
- Write `typedDueAt = result.dueAt`
- Write `typedIntervalDays = result.intervalDays`
- Keep legacy `dueAt` / `intervalDays` also updated (for display and fallback)
- Check Phase 1 completion (see below)
- Apply one-way typed→recall credit (see below)

### Recall track (`reviewTrack === 'recall'`, forward)

After `scheduleNext()`:
- Write `recallDueAt = result.dueAt`
- Write `recallIntervalDays = result.intervalDays`
- Do NOT update `typedDueAt` — recall does not credit the typed track

### Reverse recall (`reviewTrack === 'recall'`, `isReverse === true`)

The reverse CardState row only has `recallDueAt`. After `scheduleNext()`:
- Write `recallDueAt = result.dueAt`
- Write `recallIntervalDays = result.intervalDays`

For reverse reviews, the `decideProductionMode` call is skipped — they are always self-graded recall (show the Spanish word, rate yourself on whether you knew the English meaning). The session UI renders this as a self-graded flashcard with `promptSide = 'front'` (show Spanish) and `answerSide = 'back'` (English meaning).

---

## Phase 1 completion check

Called after every correct typed review on a graduated card. Add this logic inside `handleAnswer` after updating card state, only when `reviewTrack === 'typed'` or `reviewTrack === 'legacy'` and `wasTyped === true`:

```typescript
function checkPhase1Completion(state: CardState, result: ScheduleResult): boolean {
  // Phase 2 already active
  if (state.recallDueAt !== null) return false
  // Not yet eligible: need 3+ consecutive correct typed reviews post-graduation
  // Use typedReviewCount and typedAccuracyWindow as the signal.
  // The window tracks the last TYPED_ACCURACY_WINDOW_SIZE typed results.
  // We need the last 3 to all be correct (1).
  const window = state.typedAccuracyWindow
  if (window.length < 3) return false
  const lastThree = window.slice(-3)
  return lastThree.every(v => v === 1)
}
```

If `checkPhase1Completion()` returns true, **after** writing the typed track update, initialize the recall track:

```typescript
if (checkPhase1Completion(updatedState, result)) {
  const recallInterval = round((updatedState.typedIntervalDays ?? updatedState.intervalDays) * 1.5)
  updatedState.recallIntervalDays = recallInterval
  updatedState.recallDueAt = addDays(now, recallInterval)
}
```

`addDays` and `round` are local helpers you can inline — `addDays(now, n)` = `new Date(now.getTime() + n * 86400000).toISOString()`.

---

## One-way typed→recall early review credit

After a **correct** typed review (`reviewTrack === 'typed'`), if the recall track is already active (`recallDueAt !== null`) and recall is due within the next 3 days:

```typescript
const recallDueSoon = state.recallDueAt
  && (new Date(state.recallDueAt).getTime() - now.getTime()) < 3 * 86_400_000

if (wasCorrect && recallDueSoon && state.recallIntervalDays) {
  // Push recall due date forward by the same proportion as the typed interval grew
  const typedGrowthRatio = (updatedState.typedIntervalDays ?? 1) / (state.typedIntervalDays ?? 1)
  const newRecallInterval = Math.min(
    state.recallIntervalDays * typedGrowthRatio,
    params.maxIntervalDays,
  )
  updatedState.recallIntervalDays = newRecallInterval
  updatedState.recallDueAt = addDays(now, newRecallInterval)
}
```

This prevents the recall track from coming up immediately after a successful typed review of the same card.

---

## Graduation: creating CardState rows

When a card graduates (in `progressAfterReview()` in `engine/pipeline.ts`, or wherever graduation triggers CardState writes in the session pages), two rows need to be written instead of one.

### Forward row (existing)

Continue writing the existing forward CardState as today. Additionally, after writing the forward row, check Phase 1: the forward row starts in Phase 1 (no recall track yet). The recall track initializes after 3 consecutive correct typed reviews.

### Reverse row (new, created at graduation)

After writing the forward row, create a reverse CardState row:

```typescript
const forwardInterval = graduationIntervalRange(pipelineErrors, params)
const reverseRecallInterval = Math.max(1, Math.round(
  (forwardInterval[0] + forwardInterval[1]) / 2 / 2  // half of forward ideal interval
))

const reverseState: CardState = {
  ...initialCardState(userId, cardId, pipelineId),
  graduated:             true,
  reviewDirection:       'reverse',
  intervalDays:          reverseRecallInterval,
  scheduledIntervalDays: reverseRecallInterval,
  recallIntervalDays:    reverseRecallInterval,
  recallDueAt:           addDays(graduationTimestamp, reverseRecallInterval),
  dueAt:                 addDays(graduationTimestamp, reverseRecallInterval),
  lastReviewedAt:        graduationTimestamp,
  graduatedAt:           graduationTimestamp,
  introducedDate:        today,
  // typed fields stay null — reverse is never typed
  typedIntervalDays:     null,
  typedDueAt:            null,
}

await stateRepo.upsert(reverseState)
```

The reverse row should come due ~2–3 days before the forward typed interval naturally, because `reverseRecallInterval = forwardIdealInterval / 2`.

---

## Existing graduated cards: reverse row on-demand

Do NOT create reverse rows for all existing graduated cards in a migration — that would add millions of rows. Instead, create the reverse row **lazily** on the first due-date review of an existing forward card:

In `handleAnswer`, before processing the review, check:

```typescript
// For forward graduated cards, check if a reverse row exists yet
if (state.reviewDirection === 'forward' && state.graduated && reviewTrack !== 'recall') {
  const reverseExists = await stateRepo.get(userId, cardId, 'reverse')
  if (!reverseExists) {
    const reverseInterval = Math.max(1, Math.round((state.typedIntervalDays ?? state.intervalDays) / 2))
    await stateRepo.upsert({
      ...initialCardState(userId, cardId, state.pipelineId),
      graduated:             true,
      reviewDirection:       'reverse',
      intervalDays:          reverseInterval,
      scheduledIntervalDays: reverseInterval,
      recallIntervalDays:    reverseInterval,
      recallDueAt:           addDays(now, reverseInterval),
      dueAt:                 addDays(now, reverseInterval),
      lastReviewedAt:        now.toISOString(),
      graduatedAt:           state.graduatedAt ?? now.toISOString(),
      introducedDate:        today,
      typedIntervalDays:     null,
      typedDueAt:            null,
    })
  }
}
```

`stateRepo.get(userId, cardId, 'reverse')` requires updating the repository to accept an optional `reviewDirection` parameter. Currently `get(userId, cardId)` fetches by `(user_id, card_id)` — add `review_direction` as an optional third arg, defaulting to `'forward'`.

---

## lib/data/cardStates.ts changes required for this phase

### 1. `get()` method: add optional `reviewDirection`

```typescript
async get(userId: UserId, cardId: CardId, reviewDirection: 'forward' | 'reverse' = 'forward'): Promise<CardState | null> {
  const { data, error } = await this.db.from('card_states')
    .select('*')
    .eq('user_id', userId)
    .eq('card_id', cardId)
    .eq('review_direction', reviewDirection)
    .maybeSingle()
  if (error) throw new Error(error.message)
  return data ? rowToState(data) : null
}
```

### 2. `listForUser()` method: returns ALL rows (forward + reverse)

The existing method already returns all rows for a user — confirm it does not filter by `review_direction`. If it does, remove that filter.

### 3. `upsert()` method: include `review_direction` in the conflict target

The upsert conflict column set must be updated to `(user_id, card_id, review_direction)` to match the new primary key. In Supabase/PostgREST the `onConflict` option specifies the conflict columns:

```typescript
await this.db.from('card_states').upsert(row, { onConflict: 'user_id,card_id,review_direction' })
```

---

## UI: rendering forward recall and reverse reviews

### Forward recall review (reviewTrack === 'recall', !isReverse)

Use the existing self-graded flashcard UI (`FlashcardMode`). The prompt is the card's `back` (English), the answer is `front` (Spanish). The learner reads the Spanish and self-rates. Do NOT show the typing input.

The session page should determine mode:
```typescript
const isRecallReview = reviewTrack === 'recall'
const isTypedReview  = reviewTrack === 'typed' || reviewTrack === 'legacy'
// Pass to the existing production mode logic only for typed reviews:
const productionMode = isTypedReview
  ? decideProductionMode(state, now, Math.random, schedulerParams)
  : 'self-graded'
```

### Reverse recall review (isReverse === true)

Show the card's `front` (Spanish) as the prompt. The learner rates whether they knew the English meaning. Use `FlashcardMode` with `promptSide = 'front'`, `answerSide = 'back'`.

No typing for reverse reviews. `decideProductionMode` is never called for reverse.

In the session UI banner, display "← Spanish" or similar to make it clear this is a reverse direction review. The exact copy can be determined during implementation — just make it visually distinct from forward reviews.

---

## ReviewEvent recording for Phase 2

When recording a review event for a recall review:
```typescript
wasTyped:        false,
reviewMode:      classifyReviewMode(state, now),  // still applies
reviewDirection: state.reviewDirection,
wasAccelerated:  false,  // recall track is never accelerated
acceleratedPenalty: 0,
```

For a reverse review, `reviewDirection = 'reverse'`.

---

## Pipeline restart check post-accelerated-track off-ramp

This is the "pipeline restart threshold" from the design: after a card is kicked off the accelerated pipeline (`acceleratedMode` becomes `'none'`), if within the **next 3 production attempts** at least 2 are wrong → restart the learn pipeline.

Track this with two new fields on `CardState` (add to `domain/index.ts` and to the migration 055 if not already added — these can be added as a follow-up to migration 055 or bundled):

```typescript
/** How many production attempts remain in the post-accel restart window. 0 = not in window. */
postAccelRestartWindow: number
/** How many of those attempts were wrong. */
postAccelWrongCount:    number
```

Migration addition (add to 055 if not yet applied, or create 057):
```sql
ALTER TABLE card_states
  ADD COLUMN post_accel_restart_window INT NOT NULL DEFAULT 0,
  ADD COLUMN post_accel_wrong_count    INT NOT NULL DEFAULT 0;
```

Logic in `handleAnswer` after a graduated review on a forward card:
```typescript
if (state.acceleratedMode === 'none' && state.postAccelRestartWindow > 0) {
  const newWindow = state.postAccelRestartWindow - 1
  const newWrong  = state.postAccelWrongCount + (wasCorrect ? 0 : 1)

  if (newWrong >= 2) {
    // Restart the pipeline
    updatedState = {
      ...initialCardState(userId, cardId, pipelineId),
      introducedDate:          state.introducedDate,
      acceleratedMode:         'none',
      postAccelRestartWindow:  0,
      postAccelWrongCount:     0,
    }
  } else {
    updatedState.postAccelRestartWindow = newWindow
    updatedState.postAccelWrongCount    = newWrong
  }
}
```

When a card's `acceleratedMode` transitions from `'import_known'` to `'none'` (in the existing wrong-streak logic), set:
```typescript
updatedState.postAccelRestartWindow = 3
updatedState.postAccelWrongCount    = 0
```

---

## Verification checklist

After applying any additional migrations and deploying:

1. `npm run build` passes
2. `npm test` passes
3. Start a study session with a graduated card in Phase 1 — confirm it reviews as typed only
4. Get 3 consecutive correct typed reviews on a card — confirm `recall_due_at` is now set on the card state in Supabase
5. Advance time (or manually set `recall_due_at` to the past in Supabase) — confirm a recall review surfaces for that card
6. Complete a recall review — confirm `recall_due_at` advances but `typed_due_at` is unchanged
7. Complete a typed review when recall is due within 3 days — confirm recall gets early review credit (pushed forward)
8. Graduate a new card — confirm a reverse CardState row is created in Supabase
9. Make an existing graduated card come due — confirm a reverse row is created on-demand
10. Complete a reverse review — confirm it shows Spanish prompt, requires no typing, and `recall_due_at` on the reverse row advances

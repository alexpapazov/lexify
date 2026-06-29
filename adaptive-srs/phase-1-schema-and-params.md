# Phase 1 — Schema & Params (Chunks 1 + 2)

Read this file in full before touching a single file. No decisions are left open here.

## What this phase delivers

- Three new migrations (054, 055, 056)
- New repository `lib/data/userSchedulerParams.ts`
- `SchedulerParams` type + `DEFAULT_SCHEDULER_PARAMS` in `domain/index.ts`
- `CardState` and `ReviewEvent` extended with new fields in `domain/index.ts`
- `initialCardState()` updated in `engine/pipeline.ts`
- `engine/scheduler.ts` reads multipliers from a `SchedulerParams` argument (falls back to hardcoded defaults)
- `engine/productionMode.ts` reads typing probability thresholds from `SchedulerParams` (falls back)
- `engine/pipeline.ts` `graduationIntervalRange()` reads from `SchedulerParams` (falls back)
- All three session pages load params once at session start and pass to engine functions

**Visible behavior change: none.** Everything still runs on the same default values. This phase is pure infrastructure.

---

## Migration 054 — user_scheduler_params and history tables

File: `supabase/migrations/054_user_scheduler_params.sql`

```sql
-- Per-user, per-language-pair, per-direction SRS calibration parameters.
-- answer_field values: 'forward_typed', 'forward_recall', 'reverse_recall', 'standard' (legacy)
-- Future Chinese/Korean fields: 'char_typed', 'pinyin_typed', 'char_recall', etc.
CREATE TABLE user_scheduler_params (
  user_id              UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  source_language      TEXT NOT NULL,
  target_language      TEXT NOT NULL,
  answer_field         TEXT NOT NULL DEFAULT 'standard',

  -- Normal track multipliers [min, ideal, max] + floor
  good_min             REAL NOT NULL DEFAULT 2.00,
  good_ideal           REAL NOT NULL DEFAULT 2.25,
  good_max             REAL NOT NULL DEFAULT 2.50,
  good_floor           REAL NOT NULL DEFAULT 1.15,
  hard_min             REAL NOT NULL DEFAULT 1.10,
  hard_ideal           REAL NOT NULL DEFAULT 1.20,
  hard_max             REAL NOT NULL DEFAULT 1.30,
  hard_floor           REAL NOT NULL DEFAULT 1.00,
  easy_min             REAL NOT NULL DEFAULT 3.00,
  easy_ideal           REAL NOT NULL DEFAULT 3.50,
  easy_max             REAL NOT NULL DEFAULT 4.00,
  easy_floor           REAL NOT NULL DEFAULT 1.25,

  -- Accelerated track multipliers (same structure, higher defaults)
  accel_good_min       REAL NOT NULL DEFAULT 2.50,
  accel_good_ideal     REAL NOT NULL DEFAULT 3.00,
  accel_good_max       REAL NOT NULL DEFAULT 3.50,
  accel_hard_min       REAL NOT NULL DEFAULT 1.30,
  accel_hard_ideal     REAL NOT NULL DEFAULT 1.50,
  accel_hard_max       REAL NOT NULL DEFAULT 1.70,
  accel_easy_min       REAL NOT NULL DEFAULT 4.00,
  accel_easy_ideal     REAL NOT NULL DEFAULT 5.00,
  accel_easy_max       REAL NOT NULL DEFAULT 6.00,

  -- Typing probability thresholds
  typed_prob_below_70  REAL NOT NULL DEFAULT 1.00,
  typed_prob_70_to_84  REAL NOT NULL DEFAULT 0.70,
  typed_prob_85_to_94  REAL NOT NULL DEFAULT 0.35,
  typed_prob_95_plus   REAL NOT NULL DEFAULT 0.15,

  -- Shared scheduling constants
  decay_constant_days  REAL NOT NULL DEFAULT 90,
  again_reduction      REAL NOT NULL DEFAULT 0.60,
  max_interval_days    INT  NOT NULL DEFAULT 1460,

  -- Graduation intervals by pipeline struggle count (min/max days)
  grad_interval_0err_min  INT NOT NULL DEFAULT 4,
  grad_interval_0err_max  INT NOT NULL DEFAULT 6,
  grad_interval_1err_min  INT NOT NULL DEFAULT 3,
  grad_interval_1err_max  INT NOT NULL DEFAULT 4,
  grad_interval_2err_min  INT NOT NULL DEFAULT 2,
  grad_interval_2err_max  INT NOT NULL DEFAULT 3,
  grad_interval_3err_min  INT NOT NULL DEFAULT 1,
  grad_interval_3err_max  INT NOT NULL DEFAULT 2,

  -- Calibration tracking state
  calibrated_at           TIMESTAMPTZ,
  total_due_reviews       INT  NOT NULL DEFAULT 0,
  recent_retention_rate   REAL,

  -- Per-language active review combination flags
  -- Controls which tracks are enabled for this language pair.
  -- Defaults: forward_typed=true, forward_recall=true, reverse_recall=true.
  forward_typed_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  forward_recall_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  reverse_recall_enabled  BOOLEAN NOT NULL DEFAULT TRUE,

  PRIMARY KEY (user_id, source_language, target_language, answer_field)
);

ALTER TABLE user_scheduler_params ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON user_scheduler_params
  FOR ALL USING (auth.uid() = user_id);

-- Version history: snapshot stored every time calibration changes any values.
CREATE TABLE user_scheduler_params_history (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  source_language  TEXT NOT NULL,
  target_language  TEXT NOT NULL,
  answer_field     TEXT NOT NULL,
  snapshot         JSONB NOT NULL,        -- full params row at time of change
  snapshotted_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  total_due_reviews INT NOT NULL DEFAULT 0
);

ALTER TABLE user_scheduler_params_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own rows" ON user_scheduler_params_history
  FOR ALL USING (auth.uid() = user_id);
```

---

## Migration 055 — card_states additions

File: `supabase/migrations/055_card_states_dual_intervals.sql`

This adds dual-interval columns and `review_direction` to `card_states`. **The primary key must change** from `(user_id, card_id)` to `(user_id, card_id, review_direction)` because forward and reverse rows for the same card share a `card_id`.

```sql
-- Add review_direction first (with default so existing rows are backfilled)
ALTER TABLE card_states
  ADD COLUMN review_direction TEXT NOT NULL DEFAULT 'forward';

-- Add dual interval columns (nullable — null until the respective track activates)
ALTER TABLE card_states
  ADD COLUMN typed_interval_days  REAL,
  ADD COLUMN typed_due_at         TIMESTAMPTZ,
  ADD COLUMN recall_interval_days REAL,
  ADD COLUMN recall_due_at        TIMESTAMPTZ;

-- Update primary key to include review_direction
ALTER TABLE card_states DROP CONSTRAINT card_states_pkey;
ALTER TABLE card_states ADD PRIMARY KEY (user_id, card_id, review_direction);
```

**Important:** Any existing unique indexes on `(user_id, card_id)` in `card_states` must also be dropped/recreated. Check for them with:
```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'card_states';
```
If there's a unique index on `(user_id, card_id)` that is NOT the primary key, drop it and recreate as `(user_id, card_id, review_direction)`.

---

## Migration 056 — review_events additions

File: `supabase/migrations/056_review_events_accel_direction.sql`

```sql
ALTER TABLE review_events
  ADD COLUMN was_accelerated     BOOLEAN,
  ADD COLUMN accelerated_penalty INT,
  ADD COLUMN review_direction    TEXT DEFAULT 'forward';
```

No primary key change needed here — `review_events` has its own UUID `id`.

---

## domain/index.ts changes

### 1. Add `SchedulerParams` interface and default

Add after the `DEFAULT_GRADING_SETTINGS` block (around line 91), before the `Folder` section:

```typescript
// ─── Scheduler params ─────────────────────────────────────────────────────────

export interface SchedulerParams {
  // Normal track multipliers
  goodMin: number; goodIdeal: number; goodMax: number; goodFloor: number
  hardMin: number; hardIdeal: number; hardMax: number; hardFloor: number
  easyMin: number; easyIdeal: number; easyMax: number; easyFloor: number
  // Accelerated track multipliers
  accelGoodMin: number; accelGoodIdeal: number; accelGoodMax: number
  accelHardMin: number; accelHardIdeal: number; accelHardMax: number
  accelEasyMin: number; accelEasyIdeal: number; accelEasyMax: number
  // Typing probability thresholds
  typedProbBelow70: number; typedProb70to84: number
  typedProb85to94: number; typedProb95plus: number
  // Shared scheduling constants
  decayConstantDays: number; againReduction: number; maxIntervalDays: number
  // Graduation intervals by struggle count
  gradInterval0errMin: number; gradInterval0errMax: number
  gradInterval1errMin: number; gradInterval1errMax: number
  gradInterval2errMin: number; gradInterval2errMax: number
  gradInterval3errMin: number; gradInterval3errMax: number
}

export const DEFAULT_SCHEDULER_PARAMS: SchedulerParams = {
  goodMin: 2.00, goodIdeal: 2.25, goodMax: 2.50, goodFloor: 1.15,
  hardMin: 1.10, hardIdeal: 1.20, hardMax: 1.30, hardFloor: 1.00,
  easyMin: 3.00, easyIdeal: 3.50, easyMax: 4.00, easyFloor: 1.25,
  accelGoodMin: 2.50, accelGoodIdeal: 3.00, accelGoodMax: 3.50,
  accelHardMin: 1.30, accelHardIdeal: 1.50, accelHardMax: 1.70,
  accelEasyMin: 4.00, accelEasyIdeal: 5.00, accelEasyMax: 6.00,
  typedProbBelow70: 1.00, typedProb70to84: 0.70,
  typedProb85to94: 0.35, typedProb95plus: 0.15,
  decayConstantDays: 90, againReduction: 0.60, maxIntervalDays: 1460,
  gradInterval0errMin: 4, gradInterval0errMax: 6,
  gradInterval1errMin: 3, gradInterval1errMax: 4,
  gradInterval2errMin: 2, gradInterval2errMax: 3,
  gradInterval3errMin: 1, gradInterval3errMax: 2,
}
```

### 2. Add dual-interval and reviewDirection fields to CardState

Add at the end of the `CardState` interface (after `acceleratedPenalty: number` on line ~476):

```typescript
  // ── Dual-interval tracks (Phase 1 / Phase 2) ──────────────────────────────
  /**
   * When non-null, the card has entered Phase 2 (recall track active).
   * This is the "ideal" interval for the typed-production track specifically.
   * null = Phase 2 not yet unlocked (card still on single-interval legacy track).
   */
  typedIntervalDays:   number | null
  /** ISO timestamp when the typed-production track is next due. Null until Phase 2. */
  typedDueAt:          string | null
  /** Ideal interval for the self-graded recall track. Null until Phase 2 unlocked. */
  recallIntervalDays:  number | null
  /** ISO timestamp when the recall track is next due. Null until Phase 2. */
  recallDueAt:         string | null
  /**
   * 'forward' = English→Spanish (typed + recall).
   * 'reverse' = Spanish→English (recall only, never typed).
   * Separate CardState rows per direction share the same cardId.
   */
  reviewDirection:     'forward' | 'reverse'
```

### 3. Add new fields to ReviewEvent

Add after `wasTyped: boolean | null` (line ~507):

```typescript
  /** True when this review was on the accelerated (import-known) track. */
  wasAccelerated:      boolean | null
  /** Value of CardState.acceleratedPenalty at the time of this review. Null for legacy rows. */
  acceleratedPenalty:  number | null
  /** Which review direction triggered this event. Null for legacy rows. */
  reviewDirection:     'forward' | 'reverse' | null
```

---

## engine/pipeline.ts changes

### 1. Update `initialCardState()` to initialize new fields

In `initialCardState()`, add the new fields to the returned object. The current function returns a big object literal — add at the end:

```typescript
  typedIntervalDays:   null,
  typedDueAt:          null,
  recallIntervalDays:  null,
  recallDueAt:         null,
  reviewDirection:     'forward',
```

### 2. Update `graduationIntervalRange()` to accept optional params

Change the signature:

```typescript
import type { SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'

export function graduationIntervalRange(
  typingErrors: number,
  params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): [number, number] {
  if (typingErrors === 0) return [params.gradInterval0errMin, params.gradInterval0errMax]
  if (typingErrors === 1) return [params.gradInterval1errMin, params.gradInterval1errMax]
  if (typingErrors === 2) return [params.gradInterval2errMin, params.gradInterval2errMax]
  if (typingErrors === 3) return [params.gradInterval3errMin, params.gradInterval3errMax]
  return [1, 1]
}
```

The existing hardcoded values in `scheduler.ts` and the old `graduationIntervalRange` still exist — do NOT remove the `scheduler.ts` constants yet. Just update the pipeline's version. The old hardcoded `graduationIntervalRange` in `scheduler.ts` is separate (it was already there); check if `scheduler.ts` has its own copy and update that one too.

---

## engine/scheduler.ts changes

All four steps here add an optional `params: SchedulerParams` argument. The goal is zero behavior change — just plumbing.

### 1. Import SchedulerParams at top

```typescript
import type { CardState, Rating, SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
```

### 2. Update `effectiveMultiplierRange()`

```typescript
export function effectiveMultiplierRange(
  rating: 'hard' | 'good' | 'easy',
  currentIntervalDays: number,
  params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): EffectiveMultiplierRange {
  const range = {
    hard: { min: params.hardMin, ideal: params.hardIdeal, max: params.hardMax },
    good: { min: params.goodMin, ideal: params.goodIdeal, max: params.goodMax },
    easy: { min: params.easyMin, ideal: params.easyIdeal, max: params.easyMax },
  }[rating]
  const floor = { hard: params.hardFloor, good: params.goodFloor, easy: params.easyFloor }[rating]
  const decay = params.decayConstantDays
  return {
    min:   Math.max(applyMultiplierDecay(range.min,   currentIntervalDays, decay), floor),
    ideal: Math.max(applyMultiplierDecay(range.ideal, currentIntervalDays, decay), floor),
    max:   Math.max(applyMultiplierDecay(range.max,   currentIntervalDays, decay), floor),
  }
}
```

### 3. Update `acceleratedEffectiveMultiplierRange()`

```typescript
export function acceleratedEffectiveMultiplierRange(
  rating:              'hard' | 'good' | 'easy',
  currentIntervalDays: number,
  penalty:             number,
  params:              SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): EffectiveMultiplierRange {
  const accel = {
    hard: { min: params.accelHardMin, ideal: params.accelHardIdeal, max: params.accelHardMax },
    good: { min: params.accelGoodMin, ideal: params.accelGoodIdeal, max: params.accelGoodMax },
    easy: { min: params.accelEasyMin, ideal: params.accelEasyIdeal, max: params.accelEasyMax },
  }[rating]
  const normal = {
    hard: { min: params.hardMin, ideal: params.hardIdeal, max: params.hardMax },
    good: { min: params.goodMin, ideal: params.goodIdeal, max: params.goodMax },
    easy: { min: params.easyMin, ideal: params.easyIdeal, max: params.easyMax },
  }[rating]
  const floor = { hard: params.hardFloor, good: params.goodFloor, easy: params.easyFloor }[rating]
  const blend = Math.min(penalty / 3, 1)
  const blended = {
    min:   normal.min   + (accel.min   - normal.min)   * (1 - blend),
    ideal: normal.ideal + (accel.ideal - normal.ideal) * (1 - blend),
    max:   normal.max   + (accel.max   - normal.max)   * (1 - blend),
  }
  const decay = params.decayConstantDays
  return {
    min:   Math.max(applyMultiplierDecay(blended.min,   currentIntervalDays, decay), floor),
    ideal: Math.max(applyMultiplierDecay(blended.ideal, currentIntervalDays, decay), floor),
    max:   Math.max(applyMultiplierDecay(blended.max,   currentIntervalDays, decay), floor),
  }
}
```

### 4. Add `params` to `ScheduleContext`

```typescript
export interface ScheduleContext {
  now?: Date
  wrongSeverity?: number
  params?: SchedulerParams   // ← new
}
```

### 5. Update `AdaptiveScheduler.schedule()` to use params

At the top of the `schedule()` method, extract params:
```typescript
const params = ctx.params ?? DEFAULT_SCHEDULER_PARAMS
const AGAIN_REDUCTION_P = params.againReduction
const MAX_INTERVAL_DAYS_P = params.maxIntervalDays
```

Then replace every reference to `AGAIN_REDUCTION` with `AGAIN_REDUCTION_P` and `MAX_INTERVAL_DAYS` with `MAX_INTERVAL_DAYS_P` within the method body.

Replace every call to `effectiveMultiplierRange(rating, ...)` with `effectiveMultiplierRange(rating, ..., params)`.
Replace every call to `acceleratedEffectiveMultiplierRange(rating, ..., penalty)` with `acceleratedEffectiveMultiplierRange(rating, ..., penalty, params)`.

The module-level `const AGAIN_REDUCTION = 0.60` and `export const MAX_INTERVAL_DAYS = 1825` are **kept** for backwards compatibility with callers that import them directly. Do not remove them.

---

## engine/productionMode.ts changes

### Update `decideProductionMode()` to accept optional params

```typescript
import type { CardState, SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'

export function decideProductionMode(
  state: CardState,
  now: Date = new Date(),
  rng: () => number = Math.random,
  params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): ProductionMode {
  // ... existing forced-typing checks unchanged ...

  // Replace the hardcoded probability table:
  let typedProbability: number
  if (accuracy < 0.70)      typedProbability = params.typedProbBelow70
  else if (accuracy < 0.85) typedProbability = params.typedProb70to84
  else if (accuracy < 0.95) typedProbability = params.typedProb85to94
  else                       typedProbability = params.typedProb95plus

  return rng() < typedProbability ? 'typed' : 'self-graded'
}
```

The module-level constant thresholds (`0.70`, `0.85`, `0.95`) in the comments/docstring can stay — they describe the default. The actual runtime values now come from params.

---

## New file: lib/data/userSchedulerParams.ts

```typescript
import { createClient } from '@/lib/supabase/client'
import type { SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'

export interface SchedulerParamsRow extends SchedulerParams {
  userId: string
  sourceLanguage: string
  targetLanguage: string
  answerField: string
  calibratedAt: string | null
  totalDueReviews: number
  recentRetentionRate: number | null
  forwardTypedEnabled: boolean
  forwardRecallEnabled: boolean
  reverseRecallEnabled: boolean
}

export interface SchedulerParamsHistoryRow {
  id: string
  userId: string
  sourceLanguage: string
  targetLanguage: string
  answerField: string
  snapshot: SchedulerParamsRow
  snapshottedAt: string
  totalDueReviews: number
}

function rowToParams(row: Record<string, unknown>): SchedulerParamsRow {
  return {
    userId:              row.user_id as string,
    sourceLanguage:      row.source_language as string,
    targetLanguage:      row.target_language as string,
    answerField:         row.answer_field as string,
    goodMin:             row.good_min as number,
    goodIdeal:           row.good_ideal as number,
    goodMax:             row.good_max as number,
    goodFloor:           row.good_floor as number,
    hardMin:             row.hard_min as number,
    hardIdeal:           row.hard_ideal as number,
    hardMax:             row.hard_max as number,
    hardFloor:           row.hard_floor as number,
    easyMin:             row.easy_min as number,
    easyIdeal:           row.easy_ideal as number,
    easyMax:             row.easy_max as number,
    easyFloor:           row.easy_floor as number,
    accelGoodMin:        row.accel_good_min as number,
    accelGoodIdeal:      row.accel_good_ideal as number,
    accelGoodMax:        row.accel_good_max as number,
    accelHardMin:        row.accel_hard_min as number,
    accelHardIdeal:      row.accel_hard_ideal as number,
    accelHardMax:        row.accel_hard_max as number,
    accelEasyMin:        row.accel_easy_min as number,
    accelEasyIdeal:      row.accel_easy_ideal as number,
    accelEasyMax:        row.accel_easy_max as number,
    typedProbBelow70:    row.typed_prob_below_70 as number,
    typedProb70to84:     row.typed_prob_70_to_84 as number,
    typedProb85to94:     row.typed_prob_85_to_94 as number,
    typedProb95plus:     row.typed_prob_95_plus as number,
    decayConstantDays:   row.decay_constant_days as number,
    againReduction:      row.again_reduction as number,
    maxIntervalDays:     row.max_interval_days as number,
    gradInterval0errMin: row.grad_interval_0err_min as number,
    gradInterval0errMax: row.grad_interval_0err_max as number,
    gradInterval1errMin: row.grad_interval_1err_min as number,
    gradInterval1errMax: row.grad_interval_1err_max as number,
    gradInterval2errMin: row.grad_interval_2err_min as number,
    gradInterval2errMax: row.grad_interval_2err_max as number,
    gradInterval3errMin: row.grad_interval_3err_min as number,
    gradInterval3errMax: row.grad_interval_3err_max as number,
    calibratedAt:        row.calibrated_at as string | null,
    totalDueReviews:     row.total_due_reviews as number,
    recentRetentionRate: row.recent_retention_rate as number | null,
    forwardTypedEnabled:  (row.forward_typed_enabled as boolean) ?? true,
    forwardRecallEnabled: (row.forward_recall_enabled as boolean) ?? true,
    reverseRecallEnabled: (row.reverse_recall_enabled as boolean) ?? true,
  }
}

export class SupabaseUserSchedulerParamsRepository {
  private get db() { return createClient() }

  async getOrCreate(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
  ): Promise<SchedulerParamsRow> {
    // Upsert with ignore on conflict — first call creates the row with defaults,
    // subsequent calls return the existing row.
    await this.db.from('user_scheduler_params').upsert(
      { user_id: userId, source_language: sourceLanguage, target_language: targetLanguage, answer_field: answerField },
      { onConflict: 'user_id,source_language,target_language,answer_field', ignoreDuplicates: true },
    )
    const { data, error } = await this.db
      .from('user_scheduler_params')
      .select('*')
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
      .single()
    if (error) throw new Error(error.message)
    return rowToParams(data)
  }

  async listForUser(userId: string): Promise<SchedulerParamsRow[]> {
    const { data, error } = await this.db
      .from('user_scheduler_params')
      .select('*')
      .eq('user_id', userId)
    if (error) throw new Error(error.message)
    return (data ?? []).map(rowToParams)
  }

  async update(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
    updates: Partial<Record<string, unknown>>,
  ): Promise<void> {
    const { error } = await this.db
      .from('user_scheduler_params')
      .update(updates)
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
    if (error) throw new Error(error.message)
  }

  async getHistory(
    userId: string,
    sourceLanguage: string,
    targetLanguage: string,
    answerField: string,
  ): Promise<SchedulerParamsHistoryRow[]> {
    const { data, error } = await this.db
      .from('user_scheduler_params_history')
      .select('*')
      .eq('user_id', userId)
      .eq('source_language', sourceLanguage)
      .eq('target_language', targetLanguage)
      .eq('answer_field', answerField)
      .order('snapshotted_at', { ascending: false })
      .limit(50)
    if (error) throw new Error(error.message)
    return (data ?? []).map(r => ({
      id:               r.id as string,
      userId:           r.user_id as string,
      sourceLanguage:   r.source_language as string,
      targetLanguage:   r.target_language as string,
      answerField:      r.answer_field as string,
      snapshot:         r.snapshot as SchedulerParamsRow,
      snapshottedAt:    r.snapshotted_at as string,
      totalDueReviews:  r.total_due_reviews as number,
    }))
  }

  async saveHistory(snapshot: SchedulerParamsRow): Promise<void> {
    const { error } = await this.db.from('user_scheduler_params_history').insert({
      user_id:           snapshot.userId,
      source_language:   snapshot.sourceLanguage,
      target_language:   snapshot.targetLanguage,
      answer_field:      snapshot.answerField,
      snapshot:          snapshot,
      total_due_reviews: snapshot.totalDueReviews,
    })
    if (error) throw new Error(error.message)
  }
}
```

---

## lib/data/cardStates.ts changes

The repository's `rowToState()` mapper needs to read the new columns. Find the function and add:

```typescript
typedIntervalDays:   (row.typed_interval_days  as number | null) ?? null,
typedDueAt:          (row.typed_due_at         as string | null) ?? null,
recallIntervalDays:  (row.recall_interval_days as number | null) ?? null,
recallDueAt:         (row.recall_due_at        as string | null) ?? null,
reviewDirection:     (row.review_direction     as 'forward' | 'reverse') ?? 'forward',
```

The `upsert()` / `create()` methods also need to write these columns when they're present on the state object being saved. Add them to the insert/update payload:

```typescript
typed_interval_days:  state.typedIntervalDays,
typed_due_at:         state.typedDueAt,
recall_interval_days: state.recallIntervalDays,
recall_due_at:        state.recallDueAt,
review_direction:     state.reviewDirection,
```

---

## lib/data/reviewEvents.ts changes

`rowToEvent()` mapper needs the new columns:

```typescript
wasAccelerated:     (row.was_accelerated     as boolean | null) ?? null,
acceleratedPenalty: (row.accelerated_penalty as number | null) ?? null,
reviewDirection:    (row.review_direction    as 'forward' | 'reverse' | null) ?? null,
```

`create()` needs to write them:

```typescript
was_accelerated:     input.wasAccelerated,
accelerated_penalty: input.acceleratedPenalty,
review_direction:    input.reviewDirection,
```

`CreateReviewEventInput` in `lib/data/interfaces.ts` needs these optional fields added:

```typescript
wasAccelerated?:     boolean | null
acceleratedPenalty?: number | null
reviewDirection?:    'forward' | 'reverse' | null
```

---

## Session page changes (all three: study/[deckId]/session, study/all/session, study/folder/[folderId]/session)

### 1. Load scheduler params at session start

In the `load()` function (near where pipelines and card states are loaded), add:

```typescript
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'

// Inside load(), after determining sourceLang/targetLang for the deck/folder:
const schedulerParamsRepo = new SupabaseUserSchedulerParamsRepository()
const schedulerParams = await schedulerParamsRepo.getOrCreate(
  userId,
  sourceLang,   // the source language for this session
  targetLang,   // the target language for this session
  'forward_typed',  // primary bucket — Phase 1 uses one set of params for all
)
```

Store `schedulerParams` in component state: `const [schedulerParams, setSchedulerParams] = useState<SchedulerParams>(DEFAULT_SCHEDULER_PARAMS)` — update it after load.

### 2. Pass params into engine calls

Wherever `scheduleNext(state, rating)` is called, change to:
```typescript
scheduleNext(state, rating, { now, wrongSeverity, params: schedulerParams })
```

Wherever `decideProductionMode(state, now)` is called, change to:
```typescript
decideProductionMode(state, now, Math.random, schedulerParams)
```

Wherever `graduationIntervalRange(errCount)` is called in the session page, change to:
```typescript
graduationIntervalRange(errCount, schedulerParams)
```

### 3. Record new ReviewEvent fields

In `handleAnswer`, when building the review event input, add:

```typescript
wasAccelerated:     state.acceleratedMode !== null && state.acceleratedMode !== 'none',
acceleratedPenalty: state.acceleratedPenalty,
reviewDirection:    state.reviewDirection ?? 'forward',
```

---

## Lib/data/interfaces.ts changes

Add `SupabaseUserSchedulerParamsRepository` to the interfaces file or at minimum make sure `CreateReviewEventInput` in `interfaces.ts` includes the three new optional fields listed above.

---

## Verification checklist

After applying migrations and deploying:

1. `npm run build` passes — no TypeScript errors
2. `npm test` passes — no regressions in engine tests
3. In Supabase: confirm `user_scheduler_params`, `user_scheduler_params_history` tables exist
4. In Supabase: confirm `card_states` has `review_direction`, `typed_interval_days`, `typed_due_at`, `recall_interval_days`, `recall_due_at` columns
5. In Supabase: confirm `review_events` has `was_accelerated`, `accelerated_penalty`, `review_direction` columns
6. Start a study session — confirm it loads without errors and reviews behave exactly as before (no behavior change)
7. Check that a `user_scheduler_params` row is created for the language pair on first session load
8. Check the review event in Supabase — `review_direction` should be `'forward'`, `was_accelerated` should be true/false correctly

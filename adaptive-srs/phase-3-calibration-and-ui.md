# Phase 3 — Calibration Function & Settings UI (Chunks 5 + 6)

Read this file in full before touching a single file. Phases 1 and 2 must be complete before starting here.

## What this phase delivers

- `POST /api/calibrate` route: adaptive multiplier calibration that runs at end of every study session
- Graduation interval calibration sub-pass (first-review failure rate)
- Accelerated bucket calibration (weighted by `accelerated_penalty`)
- History snapshot saved to `user_scheduler_params_history` whenever values change
- Library language card gear icon panel showing: active review combination toggles, max interval setting, current constants (default vs. calibrated), version history

---

## Calibration function: app/api/calibrate/route.ts

Create this file. It runs server-side (Next.js Route Handler, not a client component).

### Payload

```typescript
// POST body:
interface CalibratePayload {
  userId:         string
  sourceLanguage: string
  targetLanguage: string
}
```

### Full algorithm

The function runs three calibration passes (one per answerField bucket): `'forward_typed'`, `'forward_recall'`, `'reverse_recall'`. Each pass is independent.

```typescript
import { createClient } from '@/lib/supabase/server'  // server-side client
import type { SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import { SupabaseUserSchedulerParamsRepository } from '@/lib/data/userSchedulerParams'

export async function POST(req: Request) {
  const { userId, sourceLanguage, targetLanguage } = await req.json()
  const repo = new SupabaseUserSchedulerParamsRepository()

  const answerFields = ['forward_typed', 'forward_recall', 'reverse_recall'] as const

  for (const answerField of answerFields) {
    await calibrateBucket(userId, sourceLanguage, targetLanguage, answerField, repo)
  }

  // Also run accelerated calibration (uses same params row for forward_typed)
  await calibrateAccelBucket(userId, sourceLanguage, targetLanguage, repo)

  return Response.json({ ok: true })
}
```

### `calibrateBucket()` — normal track

```typescript
async function calibrateBucket(
  userId: string,
  sourceLang: string,
  targetLang: string,
  answerField: 'forward_typed' | 'forward_recall' | 'reverse_recall',
  repo: SupabaseUserSchedulerParamsRepository,
) {
  const supabase = createClient()
  const params = await repo.getOrCreate(userId, sourceLang, targetLang, answerField)

  const n = params.totalDueReviews
  const windowSize    = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  const adjustmentStep = Math.max(0.01, 0.08 * Math.exp(-n / 200))

  // Determine filter conditions based on answerField
  const wasTyped       = answerField === 'forward_typed' ? true : false
  const reviewDir      = answerField === 'reverse_recall' ? 'reverse' : 'forward'

  // Query the most recent `windowSize` due-date reviews for this bucket
  const { data: events, error } = await supabase
    .from('review_events')
    .select('was_correct, reviewed_at')
    .eq('user_id', userId)
    // Note: card-level language filtering requires joining to cards.
    // Simplification: filter by review_direction + was_typed at the event level.
    // Language filtering is enforced by only looking at cards in the user's
    // language pair — add a join to cards table if needed, but start with
    // direction + was_typed as a sufficient proxy.
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)
    .order('reviewed_at', { ascending: false })
    .limit(windowSize)

  if (error || !events) return

  // Always update total_due_reviews count
  const { count: totalCount } = await supabase
    .from('review_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('review_mode', 'due')
    .eq('review_direction', reviewDir)
    .eq('was_typed', wasTyped)
    .eq('was_accelerated', false)

  const newTotal = totalCount ?? n

  // Not enough data yet — update tracking but skip adjustment
  if (events.length < windowSize) {
    await repo.update(userId, sourceLang, targetLang, answerField, {
      total_due_reviews: newTotal,
    })
    return
  }

  const retentionRate = events.filter(e => e.was_correct).length / events.length

  let newGoodIdeal = params.goodIdeal
  let newEasyIdeal = params.easyIdeal

  if (retentionRate < 0.88) {
    // Too many failures — shrink multipliers (intervals growing too fast)
    newGoodIdeal = Math.max(1.50, params.goodIdeal - adjustmentStep)
    newEasyIdeal = Math.max(2.00, params.easyIdeal - adjustmentStep)
  } else if (retentionRate > 0.92) {
    // Too few failures — grow multipliers (intervals too conservative)
    newGoodIdeal = Math.min(4.00, params.goodIdeal + adjustmentStep)
    newEasyIdeal = Math.min(6.00, params.easyIdeal + adjustmentStep)
  }

  // Graduation interval calibration (first-review failure rate)
  // Only run for forward_typed (production calibration) and forward_recall (recognition)
  let gradUpdate: Record<string, number> = {}
  if (answerField === 'forward_typed' || answerField === 'forward_recall') {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
    const { data: firstReviews } = await supabase
      .from('review_events')
      .select('was_correct')
      .eq('user_id', userId)
      .eq('reps', 1)                  // first post-graduation review
      .eq('review_direction', reviewDir)
      .eq('was_typed', wasTyped)
      .gte('reviewed_at', ninetyDaysAgo)

    if (firstReviews && firstReviews.length >= 5) {
      const failRate = firstReviews.filter(e => !e.was_correct).length / firstReviews.length
      if (failRate > 0.20) {
        // Too many failures on first review — graduation intervals too long
        gradUpdate = {
          grad_interval_0err_min: Math.max(1, params.gradInterval0errMin - 1),
          grad_interval_0err_max: Math.max(1, params.gradInterval0errMax - 1),
        }
      } else if (failRate < 0.05) {
        // Almost never failing — graduation intervals too short
        gradUpdate = {
          grad_interval_0err_min: Math.min(14, params.gradInterval0errMin + 1),
          grad_interval_0err_max: Math.min(14, params.gradInterval0errMax + 1),
        }
      }
    }
  }

  const changed = newGoodIdeal !== params.goodIdeal || newEasyIdeal !== params.easyIdeal
    || Object.keys(gradUpdate).length > 0

  if (changed) {
    // Save snapshot before updating
    await repo.saveHistory({ ...params, totalDueReviews: newTotal })
  }

  await repo.update(userId, sourceLang, targetLang, answerField, {
    good_ideal:              newGoodIdeal,
    easy_ideal:              newEasyIdeal,
    calibrated_at:           new Date().toISOString(),
    total_due_reviews:       newTotal,
    recent_retention_rate:   retentionRate,
    ...gradUpdate,
  })
}
```

### `calibrateAccelBucket()` — accelerated track

Uses the same params row as `forward_typed` but queries `was_accelerated = true` and weights each review by `max(0, 1 - accelerated_penalty / 5)`.

```typescript
async function calibrateAccelBucket(
  userId: string,
  sourceLang: string,
  targetLang: string,
  repo: SupabaseUserSchedulerParamsRepository,
) {
  const supabase = createClient()
  const params = await repo.getOrCreate(userId, sourceLang, targetLang, 'forward_typed')

  const n = params.totalDueReviews
  const windowSize    = Math.max(20, Math.min(150, Math.round(n * 0.15)))
  const adjustmentStep = Math.max(0.01, 0.08 * Math.exp(-n / 200))

  const { data: events } = await supabase
    .from('review_events')
    .select('was_correct, accelerated_penalty')
    .eq('user_id', userId)
    .eq('review_mode', 'due')
    .eq('was_accelerated', true)
    .order('reviewed_at', { ascending: false })
    .limit(windowSize)

  if (!events || events.length < windowSize) return

  // Weighted retention rate
  let weightedCorrect = 0
  let weightedTotal   = 0
  for (const e of events) {
    const weight = Math.max(0, 1 - (e.accelerated_penalty ?? 0) / 5)
    weightedTotal   += weight
    if (e.was_correct) weightedCorrect += weight
  }

  if (weightedTotal < 5) return  // not enough weighted signal

  const retentionRate = weightedCorrect / weightedTotal

  let newAccelGoodIdeal = params.accelGoodIdeal
  let newAccelEasyIdeal = params.accelEasyIdeal

  if (retentionRate < 0.88) {
    newAccelGoodIdeal = Math.max(2.50, params.accelGoodIdeal - adjustmentStep)
    newAccelEasyIdeal = Math.max(3.00, params.accelEasyIdeal - adjustmentStep)
  } else if (retentionRate > 0.92) {
    newAccelGoodIdeal = Math.min(3.50, params.accelGoodIdeal + adjustmentStep)
    newAccelEasyIdeal = Math.min(6.00, params.accelEasyIdeal + adjustmentStep)
  }

  if (newAccelGoodIdeal !== params.accelGoodIdeal || newAccelEasyIdeal !== params.accelEasyIdeal) {
    await repo.saveHistory({ ...params })
    await repo.update(userId, sourceLang, targetLang, 'forward_typed', {
      accel_good_ideal: newAccelGoodIdeal,
      accel_easy_ideal: newAccelEasyIdeal,
    })
  }
}
```

**Important note on `reps` field:** The calibration queries `review_events` with `reps = 1` for graduation interval calibration. This requires that `review_events` records a `reps` column (the post-graduation review count for that card). Check whether this column exists currently. If not, it can be approximated by counting prior review events for the same `(user_id, card_id)` up to the review's timestamp — but it's simpler to add a `reps` column to `review_events` at review time. If needed, add a migration to capture this during review recording.

---

## Session pages: fire-and-forget calibration at session end

In each of the three session pages, find the point where the session is considered complete (when the queue empties and the done screen shows). Add:

```typescript
// Fire-and-forget — do not await, do not block the done screen
if (sourceLang && targetLang) {
  fetch('/api/calibrate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userId, sourceLanguage: sourceLang, targetLanguage: targetLang }),
  }).catch(() => {})  // swallow errors
}
```

The language pair for the session can be determined from the deck's `sourceLanguage`/`targetLanguage` for deck sessions, or from the active language pair filter for all/folder sessions.

---

## Library language card gear icon panel

This is the settings/info panel that opens when the user presses the gear/info icon on a language card on the library page (`app/library/page.tsx`).

### Where to add the icon

Each language pair box in the library already renders a card. Add an ℹ/gear icon button in the top-right corner of the card, overlaid above the existing content. On click, open a modal/sheet.

### Panel structure

The panel has three sections:

#### Section 1: Review combinations

A set of toggles for which tracks are active for this language pair. These write to `user_scheduler_params.forward_typed_enabled`, `forward_recall_enabled`, `reverse_recall_enabled`.

```
Forward typed    [toggle — ON by default]   English shown, type the Spanish word
Forward recall   [toggle — ON by default]   English shown, rate whether you recalled Spanish
Reverse recall   [toggle — ON by default]   Spanish shown, rate whether you knew the English
```

Toggling any of these calls `repo.update(...)` immediately (fire-and-forget with optimistic UI). When a track is disabled, its `due_at` is not checked when building the session queue (Phase 2 queue building should gate on these flags).

#### Section 2: Max interval

A number input (or preset dropdown: 1 year / 2 years / 4 years / 8 years / no limit). Default: 1460 days (4 years). This writes to `user_scheduler_params.max_interval_days` for this language pair.

Display format: show as "4 years" not "1460 days". Conversion: `Math.round(days / 365 * 10) / 10` years.

#### Section 3: Current constants (read-only)

Show the calibrated values for this language pair, per answerField bucket. Display in a table:

| Parameter | Default | Current | Bucket |
|---|---|---|---|
| Good multiplier | 2.25 | 2.18 | Forward typed |
| Easy multiplier | 3.50 | 3.41 | Forward typed |
| ... | ... | ... | ... |

For each value, if `current === default`, show in normal text. If `current !== default`, show in a highlight color (amber or blue) to indicate it has been calibrated away from default.

Also show:
- Total due reviews per bucket (n)
- Recent retention rate (as a percentage)
- Last calibrated at (formatted date)

#### Section 4: Version history

A collapsible list of `user_scheduler_params_history` rows for this language pair. For each snapshot:
- Date and time
- `n` at time of snapshot
- Which values changed (diff from previous snapshot, or "Initial" if first)

Load history with `repo.getHistory(userId, sourceLang, targetLang, answerField)` when the section is expanded.

### Data loading

When the panel opens:
```typescript
const paramsRepo = new SupabaseUserSchedulerParamsRepository()
const allParams = await paramsRepo.listForUser(userId)
// Filter to rows matching this language pair's source/target
const pairParams = allParams.filter(p =>
  p.sourceLanguage === pair.sourceLanguage && p.targetLanguage === pair.targetLanguage
)
```

History is loaded lazily when the version history section is first opened.

---

## Verification checklist

After deploying:

1. `npm run build` passes
2. `npm test` passes
3. Complete a study session — check Supabase logs or response that `/api/calibrate` was called and returned `{ ok: true }`
4. After completing enough sessions (windowSize reviews), check that `user_scheduler_params` rows show `calibrated_at` set and multipliers potentially drifting
5. Open library page — confirm ℹ icon appears on each language card
6. Open the ℹ panel — confirm all three sections render
7. Toggle a review combination off — confirm the session page no longer queues that track's cards
8. Change max interval — confirm the value persists after page reload
9. Trigger calibration manually (set `total_due_reviews` to >= 20 in Supabase, run a session) — confirm a history snapshot is created in `user_scheduler_params_history`
10. Open version history section — confirm snapshots display with diffs

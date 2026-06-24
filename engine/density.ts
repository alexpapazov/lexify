/**
 * engine/density.ts
 *
 * Review-density smoothing for the long-term scheduler. When a correct
 * (hard/good/easy) review produces a `smoothMinDays`/`smoothMaxDays` window
 * (engine/scheduler.ts's `idealIntervalRange` / per-review blended range),
 * the exact due date can be nudged anywhere within that window to even out
 * how many cards become due on any given day — across ALL of the user's
 * decks.
 *
 * Intervals where `smoothMinDays`/`smoothMaxDays` are absent or collapse to
 * less than a day's difference (e.g. short relearn intervals) are scheduled
 * precisely — no smoothing.
 *
 * This is intentionally NOT part of engine/pipeline.ts or engine/scheduler.ts
 * (both of which stay pure / synchronous) — it's an async post-processing
 * step that callers (study session pages) apply to a freshly-scheduled
 * `dueAt` before persisting it.
 */

import type { CardStateRepository } from '@/lib/data/interfaces'
import type { UserId } from '@/domain'

/** score(day) = due_cards_on_day + |day - ideal| * SMOOTH_DISTANCE_WEIGHT */
const SMOOTH_DISTANCE_WEIGHT = 0.25

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Given an ideal due date and the [minDays, maxDays] window (in absolute
 * interval-days from the last review) that produced it, returns a (possibly
 * shifted) due date that lands on the least-crowded day within that window —
 * looking across all of the user's graduated cards.
 *
 * `minDays`/`maxDays` are absolute interval lengths (days since the last
 * review), not offsets from `idealDueAt` — the caller passes
 * `ScheduleResult.smoothMinDays` / `smoothMaxDays` directly.
 */
export async function smoothDueDate(
  userId:     UserId,
  idealDueAt: string,
  minDays:    number,
  maxDays:    number,
  idealDays:  number,
  repo:       CardStateRepository,
): Promise<string> {
  // Window collapsed to (near) a single day — nothing to smooth.
  if (maxDays - minDays < 1) return idealDueAt

  const idealDate = new Date(idealDueAt)
  const lowOffset  = Math.round(minDays - idealDays)
  const highOffset = Math.round(maxDays - idealDays)
  if (lowOffset >= highOffset) return idealDueAt

  const rangeStart = new Date(idealDate.getTime() + lowOffset * DAY_MS)
  const rangeEnd   = new Date(idealDate.getTime() + (highOffset + 1) * DAY_MS) // exclusive

  const counts = await repo.countDueByDateRange(userId, rangeStart.toISOString(), rangeEnd.toISOString())

  let best      = idealDate
  let bestScore = Infinity

  for (let offset = lowOffset; offset <= highOffset; offset++) {
    const candidate = new Date(idealDate.getTime() + offset * DAY_MS)
    const key   = candidate.toISOString().slice(0, 10)
    const score = (counts.get(key) ?? 0) + Math.abs(offset) * SMOOTH_DISTANCE_WEIGHT
    if (score < bestScore) {
      bestScore = score
      best = candidate
    }
  }

  return best.toISOString()
}

/**
 * Computes `dueAt` ISO strings for a batch of fast-tracked import-known cards,
 * distributing them across the smallest window that keeps density reasonable:
 *   windowDays = min(30, ceil(count / 3))
 * Example: 30 cards → 10 days, 300 cards → 30 days.
 *
 * Respects already-scheduled reviews when picking days — each card is
 * greedily assigned to the least-loaded day in the window.
 */
export async function batchFastTrackDueDates(
  userId:    UserId,
  count:     number,
  startDate: Date,
  repo:      CardStateRepository,
): Promise<string[]> {
  if (count === 0) return []

  const windowDays = Math.min(14, count)
  const windowEnd  = new Date(startDate.getTime() + (windowDays + 1) * DAY_MS)

  const existing = await repo.countDueByDateRange(
    userId,
    new Date(startDate.getTime() + DAY_MS).toISOString(),
    windowEnd.toISOString(),
  )

  // Build a mutable load map for days 1 through windowDays from startDate
  const days: string[] = []
  for (let d = 1; d <= windowDays; d++) {
    const date = new Date(startDate.getTime() + d * DAY_MS)
    days.push(date.toISOString().slice(0, 10))
  }
  const load = new Map<string, number>()
  for (const day of days) load.set(day, existing.get(day) ?? 0)

  // Greedily assign each card to the least-loaded day
  const result: string[] = []
  for (let i = 0; i < count; i++) {
    let bestDay  = days[0]!
    let bestLoad = load.get(bestDay)!
    for (const day of days) {
      const l = load.get(day)!
      if (l < bestLoad) { bestLoad = l; bestDay = day }
    }
    result.push(bestDay + 'T12:00:00.000Z')
    load.set(bestDay, bestLoad + 1)
  }
  return result
}

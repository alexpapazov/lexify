/**
 * engine/density.ts
 *
 * Review-density smoothing for long-term scheduling. When a review produces a
 * `[minDays, maxDays]` interval window (the FSRS fuzz range in engine/fsrs.ts,
 * or the graduationIntervalRange bucket), the exact due date can be nudged
 * anywhere within that window to even out how many cards become due on any
 * given day — across ALL of the user's decks.
 *
 * Windows that are absent or collapse to less than a day's difference (e.g.
 * short relearn intervals) are scheduled precisely — no smoothing.
 *
 * This is intentionally NOT part of engine/pipeline.ts (which stays pure /
 * synchronous) — it's an async post-processing step that callers (study
 * session pages) apply to a freshly-scheduled `dueAt` before persisting it.
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

// ─── Onboarding spread ───────────────────────────────────────────────────────
//
// Onboarding assigns each card a band window (see engine/onboarding.ts) rather than a single ideal
// day, and rates cards one at a time — so it can't use `smoothDueDate` (one query per card) or
// `batchFastTrackDueDates` (one fixed window for the whole batch). Instead the caller seeds a load
// map ONCE per session and claims days from it locally as ratings come in: batch-quality spreading
// at zero queries per keystroke.

/**
 * How strongly a card is pulled toward its band's centre, in units of "one already-scheduled card".
 * Distance is normalised by the window's half-width, so an edge day always costs exactly this much
 * more than the centre regardless of how wide the band is.
 *
 * At 1: a handful of cards cluster near the centre ("about a month"), while a big import spreads
 * essentially uniformly across the whole window, because real load quickly dominates the pull.
 */
const ONBOARD_CENTER_PULL = 1

/** ISO day key (YYYY-MM-DD) `offset` days after `startDate`. */
function dayKey(startDate: Date, offset: number): string {
  return new Date(startDate.getTime() + offset * DAY_MS).toISOString().slice(0, 10)
}

/**
 * The due timestamp for a claimed day offset. Mid-day UTC, matching `batchFastTrackDueDates` — Due
 * Now compares at DATE level (`lib/dueStatus.ts`), so the time of day only has to be one that lands
 * on the intended calendar date for the learner's timezone.
 */
export function onboardDueIso(startDate: Date, offset: number): string {
  return dayKey(startDate, offset) + 'T12:00:00.000Z'
}

/**
 * Reads how many cards are already due on each day in `1..horizonDays`, keyed by DAY OFFSET from
 * `startDate` — the shape `claimSpreadDay` consumes. One query for the whole horizon.
 */
export async function seedOnboardLoad(
  userId:      UserId,
  startDate:   Date,
  horizonDays: number,
  repo:        CardStateRepository,
): Promise<Map<number, number>> {
  const existing = await repo.countDueByDateRange(
    userId,
    new Date(startDate.getTime() + DAY_MS).toISOString(),
    new Date(startDate.getTime() + (horizonDays + 1) * DAY_MS).toISOString(),
  )
  const load = new Map<number, number>()
  for (let d = 1; d <= horizonDays; d++) load.set(d, existing.get(dayKey(startDate, d)) ?? 0)
  return load
}

/**
 * Claims the least-loaded day inside `[min, max]`, breaking ties toward `center` and then toward the
 * earlier day. MUTATES `load` so consecutive calls spread instead of stacking — that's the whole
 * point, and it's why the rating screen can assign a day per keystroke without re-querying.
 *
 * Returns the day offset from the load map's start date.
 */
export function claimSpreadDay(load: Map<number, number>, window: { min: number; max: number; center: number }): number {
  const half = Math.max(1, Math.max(window.center - window.min, window.max - window.center))
  let best = window.min
  let bestScore = Infinity
  for (let d = window.min; d <= window.max; d++) {
    const score = (load.get(d) ?? 0) + ONBOARD_CENTER_PULL * (Math.abs(d - window.center) / half)
    if (score < bestScore) { bestScore = score; best = d }
  }
  load.set(best, (load.get(best) ?? 0) + 1)
  return best
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

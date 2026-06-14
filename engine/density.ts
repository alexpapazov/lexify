/**
 * engine/density.ts
 *
 * Review-density smoothing for the long-term scheduler. When a card's
 * "ideal" interval (engine/scheduler.ts) is >= 7 days, the exact due date
 * can be nudged by up to ±(idealInterval / 7) days to even out how many
 * cards become due on any given day — across ALL of the user's decks.
 *
 * Intervals shorter than 7 days are scheduled precisely (no smoothing),
 * since shifting them meaningfully changes short-term memory effects.
 *
 * This is intentionally NOT part of engine/pipeline.ts or engine/scheduler.ts
 * (both of which stay pure / synchronous) — it's an async post-processing
 * step that callers (study session pages) apply to a freshly-scheduled
 * `dueAt` before persisting it.
 */

import type { CardStateRepository } from '@/lib/data/interfaces'
import type { UserId } from '@/domain'

/** Below this many days, schedule precisely — no smoothing. */
const SMOOTH_THRESHOLD_DAYS = 7

/** score(day) = due_cards_on_day + |day - ideal| * SMOOTH_DISTANCE_WEIGHT */
const SMOOTH_DISTANCE_WEIGHT = 0.25

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Given an "ideal" interval and the due date it produces, returns a
 * (possibly shifted) due date that lands on the least-crowded day within
 * `idealInterval / 7` days of the ideal date — looking across all of the
 * user's graduated cards.
 */
export async function smoothDueDate(
  userId:            UserId,
  idealIntervalDays: number,
  idealDueAt:        string,
  repo:              CardStateRepository,
): Promise<string> {
  if (idealIntervalDays < SMOOTH_THRESHOLD_DAYS) return idealDueAt

  const idealDate = new Date(idealDueAt)
  const range = Math.max(1, Math.round(idealIntervalDays / 7))

  const rangeStart = new Date(idealDate.getTime() - range * DAY_MS)
  const rangeEnd   = new Date(idealDate.getTime() + (range + 1) * DAY_MS) // exclusive

  const counts = await repo.countDueByDateRange(userId, rangeStart.toISOString(), rangeEnd.toISOString())

  let best      = idealDate
  let bestScore = Infinity

  for (let offset = -range; offset <= range; offset++) {
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

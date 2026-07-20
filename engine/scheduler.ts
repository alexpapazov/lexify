/**
 * engine/scheduler.ts
 *
 * Residual helpers kept after the legacy interval-multiplier scheduler was removed.
 * Graduated re-scheduling now lives entirely in engine/dueNow (the FSRS memory model);
 * pre-graduation progression lives in engine/pipeline.ts. Only two pure helpers remain:
 *
 *   - graduationIntervalRange — the calibrated [min, max] first interval a card is given
 *     the moment it graduates, bucketed by how many pipeline struggles it took. This is a
 *     SEPARATE calibrated system from the deleted multipliers and is still consumed by the
 *     session graduation block.
 *   - classifyReviewMode — 'elective' vs 'due' for an upcoming review; used for hint / UI gating.
 */

import type { CardState, SchedulerParams } from '@/domain'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'

function daysSince(iso: string, now: Date): number {
  return (now.getTime() - new Date(iso).getTime()) / (24 * 60 * 60 * 1000)
}

/**
 * Maps the number of pipeline struggles (wrong answers on any step, "?" presses,
 * and Repeat presses) to the [minDays, maxDays] interval range assigned at graduation.
 * The density smoother picks the least-loaded day within that range.
 * The ideal is Math.floor((min+max)/2).
 *
 *   0 errors  → 4–6 days  (ideal 5)
 *   1 error   → 3–4 days  (ideal 3)
 *   2 errors  → 2–3 days  (ideal 2)
 *   3 errors  → 1–2 days  (ideal 1)
 *   4+ errors → 1 day     (ideal 1)
 */
export function graduationIntervalRange(
  typingErrors: number,
  params: SchedulerParams = DEFAULT_SCHEDULER_PARAMS,
): [number, number] {
  if (typingErrors <= 0) return [params.gradInterval0errMin, params.gradInterval0errMax]
  if (typingErrors === 1) return [params.gradInterval1errMin, params.gradInterval1errMax]
  if (typingErrors === 2) return [params.gradInterval2errMin, params.gradInterval2errMax]
  if (typingErrors === 3) return [params.gradInterval3errMin, params.gradInterval3errMax]
  if (typingErrors === 4) return [params.gradInterval4errMin, params.gradInterval4errMax]
  if (typingErrors === 5) return [params.gradInterval5errMin, params.gradInterval5errMax]
  if (typingErrors === 6) return [params.gradInterval6errMin, params.gradInterval6errMax]
  if (typingErrors === 7) return [params.gradInterval7errMin, params.gradInterval7errMax]
  return [params.gradInterval8errMin, params.gradInterval8errMax] // 8 or more
}

/**
 * Classifies an *upcoming* review of `state` as 'elective' (the card isn't
 * due yet) or 'due' (on-time, overdue, first-ever, or pre-graduation) —
 * based on `dueAt`/`scheduledIntervalDays`. Callers compute this BEFORE
 * applying the review, since it describes the review that's about to happen.
 */
export function classifyReviewMode(state: CardState, now: Date = new Date()): 'elective' | 'due' {
  if (!state.graduated || !state.lastReviewedAt || state.relearningStep > 0) return 'due'
  // Prefer direct due-date comparison to interval math. Interval math can
  // use the wrong track's scheduledIntervalDays on split typed/recall cards
  // (e.g. the recall interval is longer, making a genuinely-due typed review
  // look elective). If any known due date is in the past, the review is due.
  const dueDates = [state.typedDueAt, state.recallDueAt, state.smartDueAt, state.dueAt].filter(Boolean) as string[]
  if (dueDates.length > 0) {
    return dueDates.some(d => new Date(d) <= now) ? 'due' : 'elective'
  }
  const scheduledInterval = state.scheduledIntervalDays > 0 ? state.scheduledIntervalDays : state.intervalDays
  if (scheduledInterval <= 0) return 'due'
  const elapsed  = daysSince(state.lastReviewedAt, now)
  const progress = elapsed / scheduledInterval
  return progress < 1 ? 'elective' : 'due'
}

/**
 * Whether a graduated card counts as "due today" by CALENDAR DATE, matching how the session
 * queue admits cards (`isDueByDate`) — a due date whose local day is today or earlier.
 *
 * This is deliberately looser than `classifyReviewMode`, which compares the exact due TIMESTAMP
 * to now: a card due earlier today whose stored due timestamp lands later today (an unsnapped
 * relearn/legacy schedule) is surfaced-as-due by the queue but would read 'elective' by timestamp.
 * `hintable` uses THIS so the Hint button appears on every card a due session actually serves,
 * instead of silently vanishing on those edge-of-day cards.
 */
export function isGraduatedDueByDate(state: CardState, tz: string, today: string): boolean {
  if (!state.graduated) return false
  const dueByDate = (d: string | null | undefined) =>
    !!d && new Date(d).toLocaleDateString('en-CA', { timeZone: tz }) <= today
  return [state.typedDueAt, state.recallDueAt, state.smartDueAt, state.dueAt].some(dueByDate)
}

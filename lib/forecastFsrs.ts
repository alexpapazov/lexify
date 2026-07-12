/**
 * lib/forecastFsrs.ts — pure helpers for the "Projected Due Now load" forecast, rebuilt on the
 * live FSRS stability model (instead of the old fixed interval multiplier).
 *
 * A card's future reviews are simulated as a clean all-"Good" path: reviewed on its due date, its
 * stability grows by the FSRS success formula, and the next interval is that stability scaled to the
 * pair's request retention (capped at the pair's max interval). New cards seed from a per-language
 * MEASURED initial interval (see estimateInitialInterval) rather than a hardcoded constant.
 */

import { intervalForRetention, reviewCard, type FsrsConfig, DEFAULT_FSRS_CONFIG } from '@/engine/fsrs'

/** Stability whose scheduled interval (at `retention`) equals `intervalDays`. Inverse of intervalForRetention. */
export function stabilityForInterval(intervalDays: number, retention: number): number {
  const perUnit = intervalForRetention(1, retention)          // days of interval per 1 day of stability
  return Math.max(0.1, (intervalDays > 0 ? intervalDays : 1) / (perUnit || 1))
}

export interface ReviewStep {
  /** Day offset (from now) this review lands on. */
  day: number
  /** The interval (days) that led to this review — used to route smart-typing typed vs self-graded. */
  intervalDays: number
}

/**
 * Clean all-Good FSRS review schedule as a list of day offsets, starting with an upcoming review at
 * `firstReviewDay` and growing by the FSRS success curve until it passes `horizon`.
 */
export function fsrsSchedule(
  opts: {
    stability: number; difficulty: number; firstReviewDay: number
    retention: number; maxInt: number; horizon: number
    cfg?: FsrsConfig
  },
): ReviewStep[] {
  const cfg: FsrsConfig = { ...(opts.cfg ?? DEFAULT_FSRS_CONFIG), requestRetention: opts.retention }
  const steps: ReviewStep[] = []
  let S = Math.max(0.1, opts.stability)
  let D = Math.min(10, Math.max(1, opts.difficulty))
  let day = opts.firstReviewDay
  let lead = Math.min(intervalForRetention(S, opts.retention), opts.maxInt)  // interval that led to the first review
  let guard = 0
  while (day <= opts.horizon && guard++ < 500) {
    steps.push({ day, intervalDays: Math.max(0.5, lead) })
    const elapsed = Math.max(1, Math.min(intervalForRetention(S, opts.retention), opts.maxInt))
    const rev = reviewCard({ stability: S, difficulty: D }, 'good', elapsed, cfg)
    S = rev.stability; D = rev.difficulty
    lead = Math.min(rev.intervalDays, opts.maxInt)
    day += Math.max(1, Math.round(elapsed))
  }
  return steps
}

/** Median of a numeric list (0 if empty). */
export function median(xs: number[]): number {
  if (xs.length === 0) return 0
  const a = [...xs].sort((p, q) => p - q)
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2
}

/**
 * Estimate a language's typical INITIAL post-graduation interval from existing cards, using
 * freshly-graduated cards (fewest reps) as the sample so the value reflects the graduation interval
 * rather than an interval that has since grown. Widens the reps window if too few cards, then falls
 * back to `fallback`.
 */
export function estimateInitialInterval(
  intervalsByReps: { reps: number; intervalDays: number }[], fallback = 3,
): number {
  const pick = (maxReps: number) =>
    intervalsByReps.filter(c => c.reps <= maxReps && c.intervalDays > 0).map(c => c.intervalDays)
  for (const maxReps of [1, 2, 3]) {
    const sample = pick(maxReps)
    if (sample.length >= 3 || (maxReps === 3 && sample.length > 0)) return median(sample)
  }
  return fallback
}

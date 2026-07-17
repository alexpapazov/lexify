/**
 * lib/forecastFsrs.ts — pure helpers for the "Projected Due Now load" forecast, rebuilt on the
 * live FSRS stability model (instead of the old fixed interval multiplier).
 *
 * A card's future reviews are simulated as a clean all-"Good" path: reviewed on its due date, its
 * stability grows by the FSRS success formula, and the next interval is that stability scaled to the
 * pair's request retention (capped at the pair's max interval). New cards seed from a per-language
 * MEASURED initial interval (see estimateInitialInterval) rather than a hardcoded constant.
 */

import { intervalForRetention, retrievability, stabilityAfterLapse, reviewCard, type FsrsConfig, DEFAULT_FSRS_CONFIG } from '@/engine/fsrs'
import type { Rating } from '@/domain'

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

// ─── Rating-mix (per-language grade behaviour) model ─────────────────────────

/** Fractions of each rating a language tends to get (sum to 1). */
export interface RatingMix { again: number; hard: number; good: number; easy: number }

/** A sensible fallback when a language has no rating history yet. */
export const DEFAULT_RATING_MIX: RatingMix = { again: 0.1, hard: 0.15, good: 0.65, easy: 0.1 }

/** Normalize raw rating counts into fractions (falls back to DEFAULT_RATING_MIX when empty). */
export function normalizeRatingMix(counts: Partial<Record<Rating, number>>): RatingMix {
  const a = counts.again ?? 0, h = counts.hard ?? 0, g = counts.good ?? 0, e = counts.easy ?? 0
  const tot = a + h + g + e
  if (tot <= 0) return { ...DEFAULT_RATING_MIX }
  return { again: a / tot, hard: h / tot, good: g / tot, easy: e / tot }
}

export interface WeightedStep {
  day: number
  /** Interval that led to this review (for smart typed-vs-self-graded routing). */
  intervalDays: number
  /** Expected number of reviews this step contributes (>1 accounts for lapse relearns). */
  weight: number
}

const clampD = (d: number) => Math.min(10, Math.max(1, d))

/**
 * Mean-field FSRS schedule that reflects a language's actual RATING MIX rather than assuming every
 * review is "Good". At each review the expected stability blends the success curve (weighted by the
 * hard/good/easy mix) with the lapse curve (weighted by the again rate); difficulty drifts by the
 * mix's expected delta; and each step's weight is inflated by the again rate to approximate the extra
 * relearn reviews a lapse triggers. Seeded from a stability, difficulty, and first-review day.
 */
export function fsrsScheduleMix(opts: {
  stability: number; difficulty: number; firstReviewDay: number
  retention: number; maxInt: number; horizon: number; mix: RatingMix; cfg?: FsrsConfig
}): WeightedStep[] {
  const cfg = opts.cfg ?? DEFAULT_FSRS_CONFIG
  const w = cfg.weights, r = opts.retention, m = opts.mix
  const succTot = m.hard + m.good + m.easy
  // Blended hard-penalty / easy-bonus factor across the success grades.
  const successFactor = succTot > 0 ? (m.hard * w[15]! + m.good * 1 + m.easy * w[16]!) / succTot : 1
  const diffDelta = m.again * 2.0 + m.hard * 0.6 + m.easy * -2.0   // good delta = 0
  const steps: WeightedStep[] = []
  let S = Math.max(0.1, opts.stability), D = clampD(opts.difficulty), day = opts.firstReviewDay
  let lead = Math.min(intervalForRetention(S, r), opts.maxInt)
  let guard = 0
  while (day <= opts.horizon && guard++ < 500) {
    steps.push({ day, intervalDays: Math.max(0.5, lead), weight: 1 + m.again })
    const elapsed = Math.max(1, Math.min(intervalForRetention(S, r), opts.maxInt))
    const R = retrievability(elapsed, S)
    const inc = Math.exp(w[8]!) * (11 - D) * Math.pow(S, -w[9]!) * (Math.exp(w[10]! * (1 - R)) - 1) * successFactor
    const sSucc = S * (1 + cfg.growth * inc)
    const sLapse = stabilityAfterLapse({ stability: S, difficulty: D }, elapsed, cfg)
    S = Math.max(0.1, (1 - m.again) * sSucc + m.again * sLapse)
    D = clampD(D + diffDelta)
    lead = Math.min(intervalForRetention(S, r), opts.maxInt)
    day += Math.max(1, Math.round(elapsed))
  }
  return steps
}

// ─── Shared seeding + language-model helpers (used by the analytics chart and
//     the dashboard "Coming up" bars, so both project workload identically) ────

/** Fallback initial post-graduation interval (days) when a language has no sample. */
export const DEFAULT_I0 = 3
/** Fallback FSRS difficulty when a card/language has none measured. */
export const DEFAULT_DIFFICULTY = 5

/**
 * Seed stability for a forward projection: use the card's real FSRS stability when it has one,
 * otherwise invert its current interval back to the stability that produced it (at `retention`).
 */
export function seedStability(
  stability: number | null | undefined,
  interval:  number | null | undefined,
  retention: number,
): number {
  return stability != null && stability > 0
    ? stability
    : stabilityForInterval(Math.max(0.5, interval || 1), retention)
}

/** Seed difficulty for a forward projection: the card's real difficulty, else the default. */
export function seedDifficulty(difficulty: number | null | undefined): number {
  return difficulty != null && difficulty > 0 ? difficulty : DEFAULT_DIFFICULTY
}

/** Minimal per-card shape needed to measure a language's rating behaviour. */
export interface RatingSampleState {
  reviewDirection?: string
  graduated:        boolean
  lastRating:       Rating | null
}

/**
 * Measure a language's rating mix from its graduated FORWARD cards' most-recent ratings
 * (reverse rows are recognition and excluded). Falls back to DEFAULT_RATING_MIX when empty.
 */
export function measureRatingMix(states: RatingSampleState[]): RatingMix {
  const counts: Partial<Record<Rating, number>> = {}
  for (const s of states) {
    if (s.reviewDirection === 'reverse' || !s.graduated || !s.lastRating) continue
    counts[s.lastRating] = (counts[s.lastRating] ?? 0) + 1
  }
  return normalizeRatingMix(counts)
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

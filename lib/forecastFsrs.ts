/**
 * lib/forecastFsrs.ts — pure helpers for the "Projected Due Now load" forecast, rebuilt on the
 * live FSRS stability model (instead of the old fixed interval multiplier).
 *
 * A card's future reviews are simulated as a clean all-"Good" path: reviewed on its due date, its
 * stability grows by the FSRS success formula, and the next interval is that stability scaled to the
 * pair's request retention (capped at the pair's max interval). New cards seed from a per-language
 * MEASURED initial interval (see estimateInitialInterval) rather than a hardcoded constant.
 */

import { intervalForRetention, retrievability, stabilityAfterLapse, reviewCard, fsrsFuzzRange, type FsrsConfig, DEFAULT_FSRS_CONFIG } from '@/engine/fsrs'
import type { Rating } from '@/domain'

/** Stability whose scheduled interval (at `retention`) equals `intervalDays`. Inverse of intervalForRetention. */
export function stabilityForInterval(intervalDays: number, retention: number): number {
  const perUnit = intervalForRetention(1, retention)          // days of interval per 1 day of stability
  return Math.max(0.1, (intervalDays > 0 ? intervalDays : 1) / (perUnit || 1))
}

interface ReviewStep {
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
  /** Monte Carlo realization index this step belongs to (for building a percentile band). */
  run?: number
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
  /** Per-track interval calibration (measured-vs-target retention); stretches/shrinks intervals. */
  calibration?: number
}): WeightedStep[] {
  const cfg = opts.cfg ?? DEFAULT_FSRS_CONFIG
  const w = cfg.weights, r = opts.retention, m = opts.mix
  const cal = opts.calibration ?? 1
  const succTot = m.hard + m.good + m.easy
  // Blended hard-penalty / easy-bonus factor across the success grades.
  const successFactor = succTot > 0 ? (m.hard * w[15]! + m.good * 1 + m.easy * w[16]!) / succTot : 1
  const diffDelta = m.again * 2.0 + m.hard * 0.6 + m.easy * -2.0   // good delta = 0
  const steps: WeightedStep[] = []
  let S = Math.max(0.1, opts.stability), D = clampD(opts.difficulty), day = opts.firstReviewDay
  let lead = Math.min(intervalForRetention(S, r) * cal, opts.maxInt)
  let guard = 0
  while (day <= opts.horizon && guard++ < 500) {
    steps.push({ day, intervalDays: Math.max(0.5, lead), weight: 1 + m.again })
    const elapsed = Math.max(1, Math.min(intervalForRetention(S, r) * cal, opts.maxInt))
    const R = retrievability(elapsed, S)
    const inc = Math.exp(w[8]!) * (11 - D) * Math.pow(S, -w[9]!) * (Math.exp(w[10]! * (1 - R)) - 1) * successFactor
    const sSucc = S * (1 + cfg.growth * inc)
    const sLapse = stabilityAfterLapse({ stability: S, difficulty: D }, elapsed, cfg)
    S = Math.max(0.1, (1 - m.again) * sSucc + m.again * sLapse)
    D = clampD(D + diffDelta)
    lead = Math.min(intervalForRetention(S, r) * cal, opts.maxInt)
    day += Math.max(1, Math.round(elapsed))
  }
  return steps
}

// ─── Shared seeding + language-model helpers (used by the analytics chart and
//     the dashboard "Coming up" bars, so both project workload identically) ────

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
interface RatingSampleState {
  reviewDirection?: string
  graduated:        boolean
  lastRating:       Rating | null
  /** Card maturity (post-graduation review count) — used to bucket rating DRIFT over time. */
  reps:             number
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

// ─── Maturity-varying rating model (rating DRIFT over a card's life) ──────────
// A language's grade behaviour is not constant: a fresh graduate may be rated "hard" a lot and, as it
// matures, drift toward "good"/"easy" (or the reverse). We approximate this drift cross-sectionally —
// bucket a language's graduated cards by how many times they've been reviewed (reps) and read each
// bucket's most-recent-rating mix. A card at reps≈2 stands in for "a young card"; one at reps≈30 for
// "a mature card". Sparse buckets are shrunk toward the language's pooled mix, so thin data reports a
// gentle (near-flat) curve rather than noise.

/** One maturity bucket: the rating mix for cards that have been reviewed at least `minReps` times. */
interface RatingBucket { minReps: number; mix: RatingMix; n: number }
/** A language's rating behaviour as a function of maturity — buckets sorted ascending by minReps. */
export type RatingModel = RatingBucket[]

/** Maturity breakpoints (post-graduation review counts): young → mature. */
const REPS_BREAKS = [0, 3, 8, 20]
/** Pseudo-observations pulling each bucket toward the pooled mix (shrinkage for sparse buckets). */
const BUCKET_PRIOR = 6

const RATINGS: Rating[] = ['again', 'hard', 'good', 'easy']

/**
 * Measure how a language's rating mix shifts with card maturity. Buckets graduated FORWARD cards by
 * reps and computes each bucket's most-recent-rating mix, shrunk toward the language's pooled mix so
 * a language with little data still yields a stable (near-flat) curve. Returns a step-function model
 * consumed by `mixForReps`.
 */
export function measureRatingModel(states: RatingSampleState[]): RatingModel {
  const pooled: Partial<Record<Rating, number>> = {}
  const buckets = REPS_BREAKS.map(minReps => ({ minReps, counts: {} as Partial<Record<Rating, number>>, n: 0 }))
  for (const s of states) {
    if (s.reviewDirection === 'reverse' || !s.graduated || !s.lastRating) continue
    pooled[s.lastRating] = (pooled[s.lastRating] ?? 0) + 1
    let bi = 0
    for (let i = 0; i < buckets.length; i++) if (s.reps >= buckets[i]!.minReps) bi = i
    const b = buckets[bi]!
    b.counts[s.lastRating] = (b.counts[s.lastRating] ?? 0) + 1
    b.n++
  }
  const pooledMix = normalizeRatingMix(pooled)
  return buckets.map(b => {
    const blended: Partial<Record<Rating, number>> = {}
    for (const r of RATINGS) blended[r] = (b.counts[r] ?? 0) + BUCKET_PRIOR * pooledMix[r]
    return { minReps: b.minReps, n: b.n, mix: normalizeRatingMix(blended) }
  })
}

/** The rating mix for a card that has been reviewed `reps` times (step function over the buckets). */
export function mixForReps(model: RatingModel, reps: number): RatingMix {
  if (model.length === 0) return { ...DEFAULT_RATING_MIX }
  let chosen = model[0]!
  for (const b of model) if (reps >= b.minReps) chosen = b
  return chosen.mix
}

/**
 * A short human label for a language's rating drift: compares "ease" (good/easy up, again/hard down)
 * between its youngest and oldest POPULATED maturity buckets. '' when there's too little data to tell.
 */
export function driftLabel(model: RatingModel): string {
  const pop = model.filter(b => b.n > 0)
  if (pop.length < 2) return ''
  const ease = (m: RatingMix) => m.good + m.easy * 1.5 - m.again * 1.5 - m.hard * 0.5
  const d = ease(pop[pop.length - 1]!.mix) - ease(pop[0]!.mix)
  if (d > 0.08) return 'easing with maturity'
  if (d < -0.08) return 'getting harder with maturity'
  return 'steady ratings'
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
  // Prefer the freshest cards (reps<=1) — they reflect the true graduation interval. Only widen to
  // older, longer-interval cards when there are NO fresh ones (otherwise a language dominated by
  // auto-graduated / heavily-reviewed cards reports an inflated "initial" interval).
  const fresh = pick(1)
  if (fresh.length > 0) return median(fresh)
  for (const maxReps of [2, 3]) {
    const sample = pick(maxReps)
    if (sample.length > 0) return median(sample)
  }
  return fallback
}

// ─── Monte Carlo scheduler ───────────────────────────────────────────────────
// The mean-field stepper (fsrsScheduleMix) propagates a single *expected* stability, which — because
// review frequency is convex in difficulty — systematically under-counts load (Jensen's inequality)
// and produces an artificial staircase. The Monte Carlo model instead samples an actual rating at each
// review, so a run is a real trajectory; averaging many runs gives an unbiased mean and a spread
// (percentile band). Each run is reproducible from a seed, so results are deterministic (and testable).

/** Small fast seedable PRNG (mulberry32). Deterministic given `seed`. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Draw a rating from a mix given a uniform [0,1) sample. */
export function sampleRating(mix: RatingMix, u: number): Rating {
  if (u < mix.again) return 'again'
  if (u < mix.again + mix.hard) return 'hard'
  if (u < mix.again + mix.hard + mix.good) return 'good'
  return 'easy'
}

/**
 * One sampled FSRS review trajectory: at each review a rating is drawn from `mix`, stability/difficulty
 * advance by the real engine, the next interval is fuzzed like the live scheduler, and a lapse ('again')
 * adds a same-day relearn review (the extra load a lapse creates). Returns each review's day + the
 * interval that led to it.
 */
export function fsrsScheduleSampled(opts: {
  stability: number; difficulty: number; firstReviewDay: number
  retention: number; maxInt: number; horizon: number; mix: RatingMix
  rand: () => number; cfg?: FsrsConfig; fuzz?: boolean
  /** Maturity-varying rating model. When set, the rating at each review is drawn from the mix for the
   *  card's current review count (`startReps` + reviews taken so far) instead of the static `mix`. */
  model?: RatingModel; startReps?: number
  /** Per-track interval calibration (measured-vs-target retention); stretches/shrinks each interval. */
  calibration?: number
}): ReviewStep[] {
  const cfg: FsrsConfig = { ...(opts.cfg ?? DEFAULT_FSRS_CONFIG), requestRetention: opts.retention }
  const steps: ReviewStep[] = []
  let S = Math.max(0.1, opts.stability)
  let D = Math.min(10, Math.max(1, opts.difficulty))
  let day = opts.firstReviewDay
  const cal = opts.calibration ?? 1
  let cur = Math.min(intervalForRetention(S, opts.retention), opts.maxInt) // interval that placed this review
  let reps = opts.startReps ?? 0
  let guard = 0
  while (day <= opts.horizon && guard++ < 1000) {
    steps.push({ day, intervalDays: Math.max(0.5, cur) })
    const mixNow = opts.model ? mixForReps(opts.model, reps) : opts.mix
    reps++
    const rating = sampleRating(mixNow, opts.rand())
    const elapsed = Math.max(1, cur)
    const rev = reviewCard({ stability: S, difficulty: D }, rating, elapsed, cfg)
    S = rev.stability; D = rev.difficulty
    if (rating === 'again' && day <= opts.horizon) {
      steps.push({ day, intervalDays: Math.max(0.5, cur) }) // relearn re-review lands the same day
    }
    // Apply the per-track retention calibration to the *scheduled* interval, exactly as the live
    // scheduler does (engine/dueNow) — so an over-performing track's projected load drops accordingly.
    let next = Math.min(rev.intervalDays * cal, opts.maxInt)
    if (opts.fuzz && next >= 2.5) {
      const [lo, hi] = fsrsFuzzRange(next)
      next = lo + opts.rand() * (hi - lo)
    }
    next = Math.max(1, next)
    day += Math.round(next)
    cur = next
  }
  return steps
}

/**
 * Runs `K` sampled trajectories and returns all their reviews tagged with `run` and weight `1/K`
 * (so accumulating `weight` yields the mean load and grouping by `run` yields per-realization totals
 * for a percentile band). `maxReviews` caps each run (dormancy); `stopDay` truncates each run (a track
 * ghosted elsewhere). When `maxReviews` is set, the median day runs hit it is returned as `dormantDay`
 * (for coupling a card's reverse track to when its production track goes dormant).
 */
export function monteCarloSteps(
  opts: {
    stability: number; difficulty: number; firstReviewDay: number
    retention: number; maxInt: number; horizon: number; mix: RatingMix
    K: number; fuzz?: boolean; cfg?: FsrsConfig; maxReviews?: number; stopDay?: number
    /** Maturity-varying rating model + the card's starting review count (see fsrsScheduleSampled). */
    model?: RatingModel; startReps?: number
    /** Per-track interval calibration (measured-vs-target retention). */
    calibration?: number
  },
  seed: number,
): { steps: WeightedStep[]; dormantDay: number | null } {
  const K = Math.max(1, Math.round(opts.K))
  const w = 1 / K
  const steps: WeightedStep[] = []
  const dormantDays: number[] = []
  for (let k = 0; k < K; k++) {
    const rand = mulberry32(((seed * 2654435761) ^ (k * 40503 + 0x9e3779b9)) >>> 0)
    const path = fsrsScheduleSampled({
      stability: opts.stability, difficulty: opts.difficulty, firstReviewDay: opts.firstReviewDay,
      retention: opts.retention, maxInt: opts.maxInt, horizon: opts.horizon, mix: opts.mix, rand, cfg: opts.cfg, fuzz: opts.fuzz,
      model: opts.model, startReps: opts.startReps, calibration: opts.calibration,
    })
    let count = 0
    for (const st of path) {
      if (opts.stopDay != null && st.day > opts.stopDay) break
      steps.push({ day: st.day, intervalDays: st.intervalDays, weight: w, run: k })
      count++
      if (opts.maxReviews != null && count >= opts.maxReviews) { dormantDays.push(st.day); break }
    }
  }
  return { steps, dormantDay: dormantDays.length ? Math.round(median(dormantDays)) : null }
}

/** Percentile (0..1) of a numeric list via linear interpolation (0 if empty). */
export function percentile(sortedOrNot: number[], p: number): number {
  if (sortedOrNot.length === 0) return 0
  const a = [...sortedOrNot].sort((x, y) => x - y)
  const idx = Math.min(a.length - 1, Math.max(0, p * (a.length - 1)))
  const lo = Math.floor(idx), hi = Math.ceil(idx)
  return lo === hi ? a[lo]! : a[lo]! + (a[hi]! - a[lo]!) * (idx - lo)
}

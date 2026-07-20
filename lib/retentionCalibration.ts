/**
 * Pure math for retention auto-calibration (used by app/api/calibrate/route.ts).
 *
 * The measured retention that drives the interval multiplier is a **recency-weighted** mean, not a
 * flat average: a review's weight halves every `RETENTION_HALF_LIFE_DAYS`, so the past week counts
 * far more than a month-ago struggle. This means a learner who started at 80% and has been at 95%
 * for the last week measures near 95%, and their intervals stretch accordingly — instead of being
 * dragged down by stale early misses.
 */

/** A review 7 days old counts half as much as one today; 14 days old, a quarter; etc. */
export const RETENTION_HALF_LIFE_DAYS = 7

/** exp-decay weight for a sample `ageDays` old, halving every `halfLifeDays`. */
export function recencyWeight(ageDays: number, halfLifeDays = RETENTION_HALF_LIFE_DAYS): number {
  // Guard clock skew (a review timestamped slightly in the future) — never exceed full weight.
  return Math.pow(0.5, Math.max(0, ageDays) / halfLifeDays)
}

/**
 * Recency-weighted mean of `value` samples. `value` is a per-review success score in [0,1]
 * (1 = clean correct, 0 = miss, fractional for a near-miss). Returns 0 for an empty set.
 */
export function recencyWeightedMean(
  samples: { value: number; ageDays: number }[],
  halfLifeDays = RETENTION_HALF_LIFE_DAYS,
): number {
  let wSum = 0
  let vSum = 0
  for (const s of samples) {
    const w = recencyWeight(s.ageDays, halfLifeDays)
    wSum += w
    vSum += w * s.value
  }
  return wSum > 0 ? vSum / wSum : 0
}

// Clamp on the interval-calibration multiplier: never shrink below 0.5× or stretch beyond 2.5×, so a
// noisy retention estimate can't blow up a card's schedule in one calibration pass.
export const CAL_MIN = 0.5
export const CAL_MAX = 2.5

/** Interval multiplier that corrects the stock FSRS weights toward the learner's true memory:
 *  ln(target)/ln(measured). measured > target → >1 (stretch); measured < target → <1 (shorten). */
export function retentionCalibrationFactor(measured: number, target: number): number {
  const m = Math.min(0.995, Math.max(0.5, measured))   // guard: ln(1)=0 blows up; very low is noise
  const t = Math.min(0.995, Math.max(0.5, target))
  const raw = Math.log(t) / Math.log(m)
  return Math.min(CAL_MAX, Math.max(CAL_MIN, raw))
}

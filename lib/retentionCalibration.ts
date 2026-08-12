/**
 * Pure math for retention auto-calibration (used by app/api/calibrate/route.ts).
 *
 * The measured retention that drives the interval multiplier is a **recency-weighted** mean, not a
 * flat average: a review's weight halves every `RETENTION_HALF_LIFE_DAYS`, so recent reviews count
 * far more than a month-ago struggle. This means a learner who started at 80% and has been at 95%
 * for the last stretch measures near 95%, and their intervals stretch accordingly — instead of being
 * dragged down by stale early misses.
 *
 * DAMPING (2026-07-22): the multiplier is a slow, slew-rate-limited controller, not a replace-outright
 * one. Every session refreshes the MEASUREMENT (`recent_retention_rate`), but the actuated multiplier
 * moves at most `CAL_MAX_STEP_PER_DAY` and at most once per `CAL_MIN_ACTUATE_HOURS`, staying within a
 * tight [CAL_MIN, CAL_MAX] band. A good two-day streak can no longer whipsaw the schedule.
 */

/** A review 14 days old counts half as much as one today; 28 days old, a quarter; etc. Widened from 7
 *  so the measured retention itself is less jumpy (fewer "two good days dominate" spikes). */
export const RETENTION_HALF_LIFE_DAYS = 14

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

// Clamp on the interval-calibration multiplier. History: 0.5–2.5 originally, tightened to 0.7–1.5
// when the damping controller landed, ceiling raised to 2.0 (2026-07-28) because every track had
// pinned at 1.5 — and then LOWERED to 1.3 (2026-08-11) because 2.0 was field-tested and failed: the
// stretched intervals genuinely outran the user's memory ("I don't know the words I supposedly
// know"), and a one-off SQL had to divide every calibrated interval back down. The recency-weighted
// measurement can flatter (a good recent stretch dominates), so a wide ceiling turns measurement
// noise into months-long intervals; ×1.3 keeps the stretch a correction, never a regime.
//
// The SHRINK side (0.7) is untouched deliberately — when retention drops, shortening intervals is
// exactly the response we want the controller to have room for.
//
// If stretching feels too weak later, the principled lever is LOWER TARGET RETENTION (the per-track
// sliders) — that reaches longer intervals through the FSRS math itself instead of a bolted-on
// multiplier. Do not raise this ceiling again without checking measured retention held up at 1.3.
export const CAL_MIN = 0.7
export const CAL_MAX = 1.3

/** Max the multiplier may move per actuation. A slew-rate limit: the controller creeps toward its
 *  target instead of replacing it outright, so 1.0→1.5 takes ~6 sustained days (and 1.0→2.0 ~13),
 *  not one hot streak. */
export const CAL_MAX_STEP_PER_DAY = 0.08

/** Minimum hours between multiplier moves. Measurement still refreshes every session; only the
 *  actuated multiplier is gated to ~once per day, so 5 sessions in a day = one small step, not five. */
export const CAL_MIN_ACTUATE_HOURS = 20

/** Interval multiplier that corrects the stock FSRS weights toward the learner's true memory:
 *  ln(target)/ln(measured). measured > target → >1 (stretch); measured < target → <1 (shorten).
 *  This is the *target* the damped controller creeps toward, already clamped to [CAL_MIN, CAL_MAX]. */
export function retentionCalibrationFactor(measured: number, target: number): number {
  const m = Math.min(0.995, Math.max(0.5, measured))   // guard: ln(1)=0 blows up; very low is noise
  const t = Math.min(0.995, Math.max(0.5, target))
  const raw = Math.log(t) / Math.log(m)
  return Math.min(CAL_MAX, Math.max(CAL_MIN, raw))
}

/** Slew-rate-limited move of the stored multiplier toward `target`: step at most ±maxStep, then clamp
 *  to [CAL_MIN, CAL_MAX]. This is the damping — one calibration pass can only nudge, never jump. */
export function dampedCalibration(current: number, target: number, maxStep = CAL_MAX_STEP_PER_DAY): number {
  const step = Math.max(-maxStep, Math.min(maxStep, target - current))
  return Math.min(CAL_MAX, Math.max(CAL_MIN, current + step))
}

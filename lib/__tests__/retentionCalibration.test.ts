import { recencyWeight, recencyWeightedMean, retentionCalibrationFactor, dampedCalibration, RETENTION_HALF_LIFE_DAYS, CAL_MIN, CAL_MAX, CAL_MAX_STEP_PER_DAY } from '../retentionCalibration'

describe('recencyWeight', () => {
  it('is 1 for a review right now and halves every half-life', () => {
    expect(recencyWeight(0)).toBeCloseTo(1)
    expect(recencyWeight(RETENTION_HALF_LIFE_DAYS)).toBeCloseTo(0.5)
    expect(recencyWeight(2 * RETENTION_HALF_LIFE_DAYS)).toBeCloseTo(0.25)
  })
  it('never exceeds 1 even for a future-dated review (clock skew)', () => {
    expect(recencyWeight(-3)).toBeLessThanOrEqual(1)
    expect(recencyWeight(-3)).toBeCloseTo(1)
  })
})

describe('recencyWeightedMean', () => {
  it('matches a flat mean when all samples are the same age', () => {
    const s = [{ value: 1, ageDays: 2 }, { value: 0, ageDays: 2 }, { value: 1, ageDays: 2 }]
    expect(recencyWeightedMean(s)).toBeCloseTo(2 / 3)
  })

  it('weights recent reviews far above older struggles', () => {
    // 40 old misses (~28 days ago, 80%-era) + 40 recent cleans (today).
    const old = Array.from({ length: 40 }, () => ({ value: 0, ageDays: 28 }))
    const recent = Array.from({ length: 40 }, () => ({ value: 1, ageDays: 0 }))
    const flat = (0 * 40 + 1 * 40) / 80 // = 0.5
    const weighted = recencyWeightedMean([...old, ...recent])
    expect(flat).toBeCloseTo(0.5)
    // 28 days = 2 half-lives (14d) → old weight 0.25, so 40·1 / (40·1 + 40·0.25) = 0.8.
    // Recency weighting pulls the estimate strongly toward the recent 100%, far above the flat 0.5.
    expect(weighted).toBeGreaterThan(0.75)
    expect(weighted).toBeCloseTo(0.8, 2)
  })

  it('returns 0 for no samples', () => {
    expect(recencyWeightedMean([])).toBe(0)
  })
})

describe('retentionCalibrationFactor', () => {
  it('is >1 when measured beats target (stretch intervals)', () => {
    expect(retentionCalibrationFactor(0.96, 0.90)).toBeGreaterThan(1)
  })
  it('is <1 when measured trails target (shorten intervals)', () => {
    expect(retentionCalibrationFactor(0.82, 0.90)).toBeLessThan(1)
  })
  it('clamps to [0.7, 1.5]', () => {
    expect(retentionCalibrationFactor(0.995, 0.90)).toBeLessThanOrEqual(1.5)
    expect(retentionCalibrationFactor(0.50, 0.90)).toBeGreaterThanOrEqual(0.7)
    expect(CAL_MIN).toBe(0.7)
    expect(CAL_MAX).toBe(1.5)
  })
})

describe('dampedCalibration (slew-rate limiter)', () => {
  it('moves toward the target by at most one step, not all at once', () => {
    // target well above current → creep up by exactly the step, not jump to target.
    expect(dampedCalibration(1.0, 1.5)).toBeCloseTo(1.0 + CAL_MAX_STEP_PER_DAY)
    // target below current → creep down by exactly the step.
    expect(dampedCalibration(1.0, 0.7)).toBeCloseTo(1.0 - CAL_MAX_STEP_PER_DAY)
  })
  it('snaps to a target already within one step', () => {
    expect(dampedCalibration(1.0, 1.02)).toBeCloseTo(1.02)
    expect(dampedCalibration(1.0, 0.99)).toBeCloseTo(0.99)
  })
  it('never leaves the [CAL_MIN, CAL_MAX] band', () => {
    expect(dampedCalibration(1.48, 1.5)).toBeLessThanOrEqual(CAL_MAX)
    expect(dampedCalibration(0.72, 0.7)).toBeGreaterThanOrEqual(CAL_MIN)
  })
  it('takes several passes to fully traverse the band (no whipsaw)', () => {
    let cal = 1.0
    for (let i = 0; i < 3; i++) cal = dampedCalibration(cal, 1.5)
    expect(cal).toBeCloseTo(1.0 + 3 * CAL_MAX_STEP_PER_DAY) // 1.24, still climbing — not 1.5 in one go
  })
})

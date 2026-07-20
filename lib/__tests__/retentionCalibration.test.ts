import { recencyWeight, recencyWeightedMean, retentionCalibrationFactor, RETENTION_HALF_LIFE_DAYS } from '../retentionCalibration'

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

  it('weights the recent week far above older struggles', () => {
    // 40 old misses (~21 days ago, 80%-era) + 40 recent cleans (today).
    const old = Array.from({ length: 40 }, () => ({ value: 0, ageDays: 21 }))
    const recent = Array.from({ length: 40 }, () => ({ value: 1, ageDays: 0 }))
    const flat = (0 * 40 + 1 * 40) / 80 // = 0.5
    const weighted = recencyWeightedMean([...old, ...recent])
    expect(flat).toBeCloseTo(0.5)
    // 21 days = 3 half-lives → old weight 0.125, so 40·1 / (40·1 + 40·0.125) ≈ 0.889.
    // Recency weighting pulls the estimate strongly toward the recent 100%, far above the flat 0.5.
    expect(weighted).toBeGreaterThan(0.85)
    expect(weighted).toBeCloseTo(0.889, 2)
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
  it('clamps to [0.5, 2.5]', () => {
    expect(retentionCalibrationFactor(0.995, 0.90)).toBeLessThanOrEqual(2.5)
    expect(retentionCalibrationFactor(0.50, 0.90)).toBeGreaterThanOrEqual(0.5)
  })
})

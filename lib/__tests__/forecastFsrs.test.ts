import { stabilityForInterval, fsrsSchedule, median, estimateInitialInterval } from '@/lib/forecastFsrs'
import { intervalForRetention } from '@/engine/fsrs'

describe('stabilityForInterval', () => {
  it('inverts intervalForRetention', () => {
    const S = stabilityForInterval(10, 0.9)
    expect(intervalForRetention(S, 0.9)).toBeCloseTo(10, 5)
  })
})

describe('fsrsSchedule', () => {
  it('produces strictly increasing review days that grow apart (stability rising)', () => {
    const steps = fsrsSchedule({ stability: 3, difficulty: 5, firstReviewDay: 3, retention: 0.9, maxInt: 1460, horizon: 730 })
    expect(steps.length).toBeGreaterThan(2)
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.day).toBeGreaterThan(steps[i - 1]!.day)
    const gap1 = steps[1]!.day - steps[0]!.day
    const gapN = steps[steps.length - 1]!.day - steps[steps.length - 2]!.day
    expect(gapN).toBeGreaterThan(gap1)   // intervals lengthen over time
  })

  it('caps intervals at maxInt and stays within the horizon', () => {
    const steps = fsrsSchedule({ stability: 3, difficulty: 5, firstReviewDay: 1, retention: 0.9, maxInt: 30, horizon: 365 })
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.day - steps[i - 1]!.day).toBeLessThanOrEqual(31)
    expect(steps[steps.length - 1]!.day).toBeLessThanOrEqual(365)
  })
})

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('estimateInitialInterval', () => {
  it('uses the freshest (reps<=1) cards when there are enough', () => {
    const cards = [
      { reps: 1, intervalDays: 2 }, { reps: 1, intervalDays: 2 }, { reps: 1, intervalDays: 4 },
      { reps: 10, intervalDays: 200 },  // grown card — must be ignored
    ]
    expect(estimateInitialInterval(cards)).toBe(2)
  })

  it('widens the window when too few fresh cards, then falls back', () => {
    expect(estimateInitialInterval([{ reps: 3, intervalDays: 5 }])).toBe(5)  // only one, reps<=3 path
    expect(estimateInitialInterval([], 3)).toBe(3)                            // nothing → fallback
  })
})

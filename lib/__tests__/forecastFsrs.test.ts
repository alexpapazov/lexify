import { stabilityForInterval, fsrsSchedule, fsrsScheduleMix, normalizeRatingMix, DEFAULT_RATING_MIX, median, estimateInitialInterval, seedStability, seedDifficulty, measureRatingMix, DEFAULT_DIFFICULTY, mulberry32, sampleRating, fsrsScheduleSampled, monteCarloSteps, percentile } from '@/lib/forecastFsrs'
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

describe('mulberry32', () => {
  it('is deterministic for a given seed and varies across seeds', () => {
    const a = mulberry32(42), b = mulberry32(42), c = mulberry32(43)
    const seqA = [a(), a(), a()], seqB = [b(), b(), b()], seqC = [c(), c(), c()]
    expect(seqA).toEqual(seqB)
    expect(seqA).not.toEqual(seqC)
    for (const x of [...seqA, ...seqC]) { expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(1) }
  })
})

describe('sampleRating', () => {
  it('maps uniform samples onto the mix cumulative buckets', () => {
    const mix = { again: 0.1, hard: 0.2, good: 0.6, easy: 0.1 }
    expect(sampleRating(mix, 0.05)).toBe('again')
    expect(sampleRating(mix, 0.2)).toBe('hard')
    expect(sampleRating(mix, 0.5)).toBe('good')
    expect(sampleRating(mix, 0.95)).toBe('easy')
  })
})

describe('fsrsScheduleSampled', () => {
  it('produces increasing review days within the horizon', () => {
    const rand = mulberry32(7)
    const steps = fsrsScheduleSampled({ stability: 3, difficulty: 5, firstReviewDay: 3, retention: 0.9, maxInt: 1460, horizon: 730, mix: DEFAULT_RATING_MIX, rand, fuzz: true })
    expect(steps.length).toBeGreaterThan(2)
    for (let i = 1; i < steps.length; i++) expect(steps[i]!.day).toBeGreaterThanOrEqual(steps[i - 1]!.day)
    expect(steps[steps.length - 1]!.day).toBeLessThanOrEqual(730)
  })
  it('an all-again mix reviews far more often than an all-good mix (lapses add load)', () => {
    const allGood = { again: 0, hard: 0, good: 1, easy: 0 }
    const allAgain = { again: 1, hard: 0, good: 0, easy: 0 }
    const good = fsrsScheduleSampled({ stability: 3, difficulty: 5, firstReviewDay: 1, retention: 0.9, maxInt: 1460, horizon: 365, mix: allGood, rand: mulberry32(1) })
    const bad  = fsrsScheduleSampled({ stability: 3, difficulty: 5, firstReviewDay: 1, retention: 0.9, maxInt: 1460, horizon: 365, mix: allAgain, rand: mulberry32(1) })
    expect(bad.length).toBeGreaterThan(good.length)
  })
})

describe('monteCarloSteps', () => {
  it('is reproducible for a seed and averages to weight 1 per run', () => {
    const opts = { stability: 3, difficulty: 5, firstReviewDay: 3, retention: 0.9, maxInt: 1460, horizon: 365, mix: DEFAULT_RATING_MIX, K: 40, fuzz: true }
    const a = monteCarloSteps(opts, 99)
    const b = monteCarloSteps(opts, 99)
    expect(a.steps.length).toBe(b.steps.length)
    const totalWeight = a.steps.reduce((s, x) => s + x.weight, 0)
    // ~ mean reviews per run; should be a positive, finite number and match the run count scale
    expect(totalWeight).toBeGreaterThan(0)
    const runs = new Set(a.steps.map(s => s.run))
    expect(runs.size).toBeLessThanOrEqual(40)
  })
  it('honors maxReviews (dormancy) by capping each run and reporting a dormant day', () => {
    const { steps, dormantDay } = monteCarloSteps({ stability: 3, difficulty: 5, firstReviewDay: 2, retention: 0.9, maxInt: 1460, horizon: 730, mix: DEFAULT_RATING_MIX, K: 20, maxReviews: 3 }, 5)
    const perRun = new Map<number, number>()
    for (const s of steps) perRun.set(s.run!, (perRun.get(s.run!) ?? 0) + 1)
    for (const n of perRun.values()) expect(n).toBeLessThanOrEqual(3)
    expect(dormantDay).not.toBeNull()
  })
  it('honors stopDay by truncating runs', () => {
    const { steps } = monteCarloSteps({ stability: 3, difficulty: 5, firstReviewDay: 2, retention: 0.9, maxInt: 1460, horizon: 730, mix: DEFAULT_RATING_MIX, K: 10, stopDay: 100 }, 3)
    for (const s of steps) expect(s.day).toBeLessThanOrEqual(100)
  })
})

describe('percentile', () => {
  it('returns interpolated order statistics', () => {
    const xs = [10, 20, 30, 40, 50]
    expect(percentile(xs, 0)).toBe(10)
    expect(percentile(xs, 1)).toBe(50)
    expect(percentile(xs, 0.5)).toBe(30)
    expect(percentile([], 0.5)).toBe(0)
  })
})

describe('normalizeRatingMix', () => {
  it('turns counts into fractions summing to 1', () => {
    const m = normalizeRatingMix({ again: 1, hard: 1, good: 6, easy: 2 })
    expect(m.again + m.hard + m.good + m.easy).toBeCloseTo(1, 6)
    expect(m.good).toBeCloseTo(0.6, 6)
  })
  it('falls back to the default when empty', () => {
    expect(normalizeRatingMix({})).toEqual(DEFAULT_RATING_MIX)
  })
})

describe('fsrsScheduleMix', () => {
  const base = { stability: 3, difficulty: 5, firstReviewDay: 3, retention: 0.9, maxInt: 1460, horizon: 730 }
  it('a harder rating mix schedules MORE reviews than an easier one', () => {
    const hard = fsrsScheduleMix({ ...base, mix: { again: 0.25, hard: 0.4, good: 0.35, easy: 0 } })
    const easy = fsrsScheduleMix({ ...base, mix: { again: 0.02, hard: 0.05, good: 0.43, easy: 0.5 } })
    const load = (s: ReturnType<typeof fsrsScheduleMix>) => s.reduce((sum, x) => sum + x.weight, 0)
    expect(load(hard)).toBeGreaterThan(load(easy))
  })
  it('lapses inflate each step weight above 1', () => {
    const steps = fsrsScheduleMix({ ...base, mix: { again: 0.2, hard: 0.1, good: 0.6, easy: 0.1 } })
    expect(steps[0]!.weight).toBeCloseTo(1.2, 6)
  })
})

describe('median', () => {
  it('handles odd and even lengths', () => {
    expect(median([3, 1, 2])).toBe(2)
    expect(median([4, 1, 2, 3])).toBe(2.5)
    expect(median([])).toBe(0)
  })
})

describe('seedStability / seedDifficulty (shared by analytics + Coming-up bars)', () => {
  it('uses the real stability when present, else inverts the interval', () => {
    expect(seedStability(12, 3, 0.9)).toBe(12)                      // real S wins
    expect(seedStability(null, 10, 0.9)).toBeCloseTo(stabilityForInterval(10, 0.9), 6)
    expect(seedStability(0, 5, 0.9)).toBeCloseTo(stabilityForInterval(5, 0.9), 6)  // 0 is not a real S
  })
  it('difficulty falls back to the default when missing', () => {
    expect(seedDifficulty(7)).toBe(7)
    expect(seedDifficulty(null)).toBe(DEFAULT_DIFFICULTY)
    expect(seedDifficulty(0)).toBe(DEFAULT_DIFFICULTY)
  })
})

describe('measureRatingMix', () => {
  it('counts only graduated FORWARD rows and ignores reverse / ungraduated', () => {
    const mix = measureRatingMix([
      { graduated: true,  lastRating: 'good' },
      { graduated: true,  lastRating: 'good' },
      { graduated: true,  lastRating: 'again' },
      { graduated: true,  lastRating: 'hard', reviewDirection: 'reverse' }, // excluded (reverse)
      { graduated: false, lastRating: 'easy' },                              // excluded (not graduated)
    ])
    expect(mix.good).toBeCloseTo(2 / 3, 6)
    expect(mix.again).toBeCloseTo(1 / 3, 6)
    expect(mix.hard).toBe(0)
  })
  it('falls back to the default mix when there is no forward history', () => {
    expect(measureRatingMix([{ graduated: true, lastRating: null, reviewDirection: 'reverse' }])).toEqual(DEFAULT_RATING_MIX)
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

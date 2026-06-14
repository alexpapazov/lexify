import { scheduleNext, applyMultiplierDecay, BASE_MULTIPLIER, MIN_EFFECTIVE_MULTIPLIER } from '../scheduler'
import type { CardState } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-14T00:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

function baseState(overrides: Partial<CardState> = {}): CardState {
  return {
    userId: 'user-1',
    cardId: 'card-1',
    pipelineId: 'pipeline-1',
    currentStepOrder: 0,
    correctInStep: 0,
    graduated: true,
    dueAt: null,
    intervalDays: 10,
    ease: 2.5,
    reps: 5,
    lapses: 0,
    lastRating: 'good',
    lastReviewedAt: daysAgo(10),
    introducedDate: '2026-01-01',
    lapseClusterCount: 0,
    lastLapseAt: null,
    ...overrides,
  }
}

describe('applyMultiplierDecay', () => {
  it('returns the base multiplier when currentInterval is 0', () => {
    expect(applyMultiplierDecay(2.25, 0)).toBeCloseTo(2.25, 5)
  })

  it('decays toward 1 as the interval grows', () => {
    const at90  = applyMultiplierDecay(2.25, 90)   // decayFactor = 0.5
    const at810 = applyMultiplierDecay(2.25, 810)  // decayFactor = 0.1
    expect(at90).toBeCloseTo(1 + 1.25 * 0.5, 5)
    expect(at810).toBeCloseTo(1 + 1.25 * 0.1, 5)
    expect(at810).toBeLessThan(at90)
    expect(at810).toBeGreaterThan(1)
  })
})

describe('graduation / first long-term review', () => {
  it('uses a flat initial interval keyed by rating when there is no prior review', () => {
    const fresh = baseState({ intervalDays: 0, lastReviewedAt: null, lapses: 0, reps: 0 })

    expect(scheduleNext(fresh, 'good', { now: NOW }).intervalDays).toBe(3)
    expect(scheduleNext(fresh, 'easy', { now: NOW }).intervalDays).toBe(7)
    expect(scheduleNext(fresh, 'hard', { now: NOW }).intervalDays).toBe(1)
  })
})

describe('correct answers — on-time / overdue', () => {
  it('on-time "good" review applies the decayed multiplier to the current interval', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(10) })
    const result = scheduleNext(state, 'good', { now: NOW })

    const expectedMult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    expect(result.intervalDays).toBeCloseTo(10 * expectedMult, 3)
    expect(result.lapseClusterCount).toBe(0)
  })

  it('overdue review rewards the larger elapsed gap before applying the multiplier', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(20) }) // progress = 2
    const result = scheduleNext(state, 'good', { now: NOW })

    const expectedMult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    expect(result.intervalDays).toBeCloseTo(20 * expectedMult, 3)
  })

  it('"easy" produces a larger interval than "good" at the same interval', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(10) })
    const good = scheduleNext(state, 'good', { now: NOW })
    const easy = scheduleNext(state, 'easy', { now: NOW })
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays)
  })

  it('"hard" nudges ease down, "easy" nudges ease up', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(10), ease: 2.5 })
    expect(scheduleNext(state, 'hard', { now: NOW }).ease).toBeLessThan(2.5)
    expect(scheduleNext(state, 'easy', { now: NOW }).ease).toBeGreaterThan(2.5)
    expect(scheduleNext(state, 'good', { now: NOW }).ease).toBe(2.5)
  })
})

describe('correct answers — early / elective', () => {
  it('blends the multiplier toward 1 based on how early the review is', () => {
    // progress = 2/10 = 0.2
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(2) })
    const result = scheduleNext(state, 'good', { now: NOW })

    const mult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    const blended = 1 + 0.2 * (mult - 1)
    expect(result.intervalDays).toBeCloseTo(10 * blended, 3)
    // Early reviews should never produce a *smaller* interval than current.
    expect(result.intervalDays).toBeGreaterThan(10)
    expect(result.intervalDays).toBeLessThan(10 * mult)
  })

  it('reviewing immediately (elapsed ~ 0) leaves the interval essentially unchanged', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: NOW.toISOString() })
    const result = scheduleNext(state, 'good', { now: NOW })
    expect(result.intervalDays).toBeCloseTo(10, 3)
  })
})

describe('wrong answers — due / overdue', () => {
  it('shrinks the interval from currentInterval (not elapsed) on the first lapse', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(15) }) // overdue
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // range [0.3, 0.5], severity 0.5 -> midpoint 0.4
    expect(result.intervalDays).toBeCloseTo(10 * 0.4, 3)
    expect(result.lapseClusterCount).toBe(1)
  })

  it('mild severity lands near the top of the range, severe near the bottom', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(10) })
    const mild   = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0 })
    const severe = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    expect(mild.intervalDays).toBeCloseTo(10 * 0.5, 3)
    expect(severe.intervalDays).toBeCloseTo(10 * 0.3, 3)
    expect(severe.intervalDays).toBeLessThan(mild.intervalDays)
  })

  it('a second close-together lapse uses the tighter range and increments the cluster', () => {
    const firstLapseAt = daysAgo(0.1) // ~2.4 hours ago — within the 24h window
    const state = baseState({
      intervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 1, lastLapseAt: firstLapseAt,
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // range [0.15, 0.25], severity 0.5 -> midpoint 0.2
    expect(result.intervalDays).toBeCloseTo(10 * 0.2, 3)
    expect(result.lapseClusterCount).toBe(2)
  })

  it('a lapse more than 24h after the last one starts a fresh cluster', () => {
    const oldLapseAt = daysAgo(2) // 2 days ago — outside the 24h window
    const state = baseState({
      intervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: oldLapseAt,
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.lapseClusterCount).toBe(1)
    expect(result.intervalDays).toBeCloseTo(10 * 0.4, 3)
  })

  it('a third close-together lapse resets the interval to 1 day without relearn', () => {
    const state = baseState({
      intervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.intervalDays).toBe(1)
    expect(result.lapseClusterCount).toBe(3)
    expect(result.relearn).toBeFalsy()
  })
})

describe('wrong answers — early / elective', () => {
  it('shrinks the interval from elapsed time on the first lapse', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(2) }) // progress = 0.2
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // range [0.5, 0.8], severity 0.5 -> midpoint 0.65
    expect(result.intervalDays).toBeCloseTo(2 * 0.65, 3)
    expect(result.lapseClusterCount).toBe(1)
  })

  it('a third close-together early lapse triggers relearn', () => {
    const state = baseState({
      intervalDays: 10, lastReviewedAt: daysAgo(2),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.relearn).toBe(true)
    expect(result.intervalDays).toBe(1)
    expect(result.lapseClusterCount).toBe(3)
  })

  it('never produces an interval below 1 day', () => {
    const state = baseState({ intervalDays: 10, lastReviewedAt: daysAgo(0.01) }) // tiny elapsed
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    expect(result.intervalDays).toBeGreaterThanOrEqual(1)
  })
})

describe('correct answer resets lapse clustering', () => {
  it('clears lapseClusterCount on a correct review', () => {
    const state = baseState({
      intervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'good', { now: NOW })
    expect(result.lapseClusterCount).toBe(0)
  })
})

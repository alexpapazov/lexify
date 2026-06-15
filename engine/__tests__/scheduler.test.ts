import { scheduleNext, classifyReviewMode, applyMultiplierDecay, BASE_MULTIPLIER, MIN_EFFECTIVE_MULTIPLIER } from '../scheduler'
import type { CardState } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-14T00:00:00.000Z')

/** The 10-minute "Again" relearn retry window, expressed in days. */
const RELEARN_RETRY_DAYS = 10 / (24 * 60)

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

function addMinutes(d: Date, minutes: number): string {
  return new Date(d.getTime() + minutes * 60 * 1000).toISOString()
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
    scheduledIntervalDays: 10,
    ease: 2.5,
    reps: 5,
    lapses: 0,
    lastRating: 'good',
    lastReviewedAt: daysAgo(10),
    introducedDate: '2026-01-01',
    lapseClusterCount: 0,
    lastLapseAt: null,
    graduatedAt: daysAgo(30),
    relearningStep: 0,
    pendingIntervalDays: null,
    typedAccuracyWindow: [],
    typedReviewCount: 0,
    lastTypedReviewAt: null,
    forcedTypedRemaining: 0,
    intervalHistory: [],
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

describe('classifyReviewMode', () => {
  it('returns "due" for a never-reviewed card (pre-graduation or first-ever review)', () => {
    const state = baseState({ graduated: false, lastReviewedAt: null, intervalDays: 0, scheduledIntervalDays: 0 })
    expect(classifyReviewMode(state, NOW)).toBe('due')
  })

  it('returns "due" while in the 10-minute relearn loop, regardless of timing', () => {
    const state = baseState({ relearningStep: 1, lastReviewedAt: daysAgo(0.001) })
    expect(classifyReviewMode(state, NOW)).toBe('due')
  })

  it('returns "elective" when reviewed before the scheduled gap has elapsed', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(4) })
    expect(classifyReviewMode(state, NOW)).toBe('elective')
  })

  it('returns "due" once the scheduled gap has fully elapsed', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10) })
    expect(classifyReviewMode(state, NOW)).toBe('due')
  })

  it('returns "due" when overdue', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(15) })
    expect(classifyReviewMode(state, NOW)).toBe('due')
  })
})

describe('graduation / first long-term review', () => {
  it('uses a flat initial interval keyed by rating when there is no prior review', () => {
    const fresh = baseState({ intervalDays: 0, scheduledIntervalDays: 0, lastReviewedAt: null, lapses: 0, reps: 0 })

    const good = scheduleNext(fresh, 'good', { now: NOW })
    expect(good.intervalDays).toBe(3)
    expect(good.scheduledIntervalDays).toBe(3)
    expect(good.relearningStep).toBe(0)
    expect(good.pendingIntervalDays).toBeNull()

    expect(scheduleNext(fresh, 'easy', { now: NOW }).intervalDays).toBe(7)
    expect(scheduleNext(fresh, 'hard', { now: NOW }).intervalDays).toBe(1)
  })
})

describe('correct answers — on-time / overdue', () => {
  it('on-time "good" review applies the decayed multiplier to the current interval', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10) })
    const result = scheduleNext(state, 'good', { now: NOW })

    const expectedMult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    expect(result.intervalDays).toBeCloseTo(10 * expectedMult, 3)
    expect(result.scheduledIntervalDays).toBeCloseTo(result.intervalDays, 3)
    expect(result.lapseClusterCount).toBe(0)
    expect(result.noChange).toBeFalsy()
    expect(result.smoothMinDays).toBeDefined()
    expect(result.smoothMaxDays).toBeDefined()
  })

  it('overdue review rewards the larger elapsed gap before applying the multiplier', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(20) }) // progress = 2
    const result = scheduleNext(state, 'good', { now: NOW })

    const expectedMult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    expect(result.intervalDays).toBeCloseTo(20 * expectedMult, 3)
  })

  it('"easy" produces a larger interval than "good" at the same interval', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10) })
    const good = scheduleNext(state, 'good', { now: NOW })
    const easy = scheduleNext(state, 'easy', { now: NOW })
    expect(easy.intervalDays).toBeGreaterThan(good.intervalDays)
  })

  it('"hard" nudges ease down, "easy" nudges ease up', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10), ease: 2.5 })
    expect(scheduleNext(state, 'hard', { now: NOW }).ease).toBeLessThan(2.5)
    expect(scheduleNext(state, 'easy', { now: NOW }).ease).toBeGreaterThan(2.5)
    expect(scheduleNext(state, 'good', { now: NOW }).ease).toBe(2.5)
  })
})

describe('correct answers — early / elective (progress >= 0.30)', () => {
  it('blends the multiplier toward 1 based on how early the review is', () => {
    // progress = 4/10 = 0.4 — above the very-early threshold
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(4) })
    const result = scheduleNext(state, 'good', { now: NOW })

    const mult = Math.max(applyMultiplierDecay(BASE_MULTIPLIER.good, 10), MIN_EFFECTIVE_MULTIPLIER.good)
    const blended = 1 + 0.4 * (mult - 1)
    expect(result.intervalDays).toBeCloseTo(10 * blended, 3)
    expect(result.noChange).toBeFalsy()
    // Early reviews should never produce a *smaller* interval than current.
    expect(result.intervalDays).toBeGreaterThan(10)
    expect(result.intervalDays).toBeLessThan(10 * mult)
  })
})

describe('very-early correct guard (progress < 0.30)', () => {
  it('leaves the schedule completely unchanged for a correct, very-early review', () => {
    // progress = 1/10 = 0.1 — below the very-early threshold
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(1), dueAt: null })
    const result = scheduleNext(state, 'good', { now: NOW })

    expect(result.noChange).toBe(true)
    expect(result.intervalDays).toBe(10)
    expect(result.scheduledIntervalDays).toBe(10)
    expect(result.relearningStep).toBe(0)
    expect(result.pendingIntervalDays).toBeNull()
    expect(result.reviewMode).toBe('elective')
    expect(result.dueAt).toBe(new Date(NOW.getTime() + 10 * DAY_MS).toISOString())
  })

  it('reviewing immediately (elapsed ~ 0) is also a no-op', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: NOW.toISOString() })
    const result = scheduleNext(state, 'good', { now: NOW })
    expect(result.noChange).toBe(true)
    expect(result.intervalDays).toBe(10)
  })

  it('does NOT apply to "again" — a wrong answer always starts the relearn loop', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(1) })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.noChange).toBeFalsy()
    expect(result.relearningStep).toBe(1)
  })
})

describe('wrong answers — due / overdue (entering the 10-minute relearn loop)', () => {
  it('computes a pending shrunken interval from currentInterval (not elapsed) on the first lapse', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(15) }) // overdue
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })

    // range [0.3, 0.5], severity 0.5 -> midpoint 0.4
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.4, 3)
    // The "ideal" interval is untouched until the loop recovers.
    expect(result.intervalDays).toBe(10)
    expect(result.lapseClusterCount).toBe(1)
    expect(result.relearningStep).toBe(1)
    expect(result.relearn).toBeFalsy()
    expect(result.scheduledIntervalDays).toBeCloseTo(RELEARN_RETRY_DAYS, 6)
    expect(result.dueAt).toBe(addMinutes(NOW, 10))
  })

  it('mild severity lands near the top of the pending range, severe near the bottom', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10) })
    const mild   = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0 })
    const severe = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    expect(mild.pendingIntervalDays).toBeCloseTo(10 * 0.5, 3)
    expect(severe.pendingIntervalDays).toBeCloseTo(10 * 0.3, 3)
    expect(severe.pendingIntervalDays!).toBeLessThan(mild.pendingIntervalDays!)
  })

  it('a second close-together lapse uses the tighter range and increments the cluster', () => {
    const firstLapseAt = daysAgo(0.1) // ~2.4 hours ago — within the 24h window
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 1, lastLapseAt: firstLapseAt,
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // range [0.15, 0.25], severity 0.5 -> midpoint 0.2
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.2, 3)
    expect(result.lapseClusterCount).toBe(2)
    expect(result.relearningStep).toBe(1)
  })

  it('a lapse more than 24h after the last one starts a fresh cluster', () => {
    const oldLapseAt = daysAgo(2) // 2 days ago — outside the 24h window
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: oldLapseAt,
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.lapseClusterCount).toBe(1)
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.4, 3)
  })

  it('a third close-together lapse always sends the card back to relearning, regardless of timing', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.relearn).toBe(true)
    expect(result.intervalDays).toBe(1)
    expect(result.scheduledIntervalDays).toBe(1)
    expect(result.lapseClusterCount).toBe(3)
    expect(result.relearningStep).toBe(0)
    expect(result.pendingIntervalDays).toBeNull()
  })
})

describe('wrong answers — early / elective', () => {
  it('shrinks the pending interval from elapsed time on the first lapse', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(2) }) // progress = 0.2
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // range [0.5, 0.8], severity 0.5 -> midpoint 0.65
    expect(result.pendingIntervalDays).toBeCloseTo(2 * 0.65, 3)
    expect(result.lapseClusterCount).toBe(1)
    expect(result.relearningStep).toBe(1)
    expect(result.intervalDays).toBe(10)
  })

  it('a third close-together early lapse also triggers full relearn', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(2),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.relearn).toBe(true)
    expect(result.intervalDays).toBe(1)
    expect(result.lapseClusterCount).toBe(3)
  })

  it('never produces a pending interval below 1 day', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(0.01) }) // tiny elapsed
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    expect(result.pendingIntervalDays!).toBeGreaterThanOrEqual(1)
  })
})

describe('10-minute relearn loop — recovery and continuation', () => {
  it('recovery: a correct answer applies the pending interval and exits the loop', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: 4,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
      ease: 2.5,
    })
    const result = scheduleNext(state, 'good', { now: NOW })

    expect(result.intervalDays).toBe(4)
    expect(result.scheduledIntervalDays).toBe(4)
    expect(result.relearningStep).toBe(0)
    expect(result.pendingIntervalDays).toBeNull()
    expect(result.lapseClusterCount).toBe(0)
    expect(result.dueAt).toBe(addMinutes(NOW, 4 * 24 * 60))
    expect(result.ease).toBe(2.5) // "good" doesn't change ease
  })

  it('recovery falls back to currentInterval when no pendingIntervalDays was recorded', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: null,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
    })
    const result = scheduleNext(state, 'good', { now: NOW })
    expect(result.intervalDays).toBe(10)
  })

  it('continuation: failing the retry again halves the pending interval and re-enters the loop', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: 4,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005), // within 24h -> cluster becomes 2
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })

    expect(result.relearningStep).toBe(2)
    expect(result.pendingIntervalDays).toBeCloseTo(2, 3) // 4 * 0.5
    expect(result.lapseClusterCount).toBe(2)
    expect(result.intervalDays).toBe(10) // ideal interval untouched
    expect(result.scheduledIntervalDays).toBeCloseTo(RELEARN_RETRY_DAYS, 6)
    expect(result.dueAt).toBe(addMinutes(NOW, 10))
    expect(result.relearn).toBeFalsy()
  })

  it('continuation falls back to 30% of currentInterval when pendingIntervalDays was never recorded', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: null,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // basePending = 10 * 0.3 = 3, halved = 1.5
    expect(result.pendingIntervalDays).toBeCloseTo(1.5, 3)
  })

  it('a third clustered failure while already in the loop sends the card back to relearning', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 2, pendingIntervalDays: 2,
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.005),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })

    expect(result.relearn).toBe(true)
    expect(result.intervalDays).toBe(1)
    expect(result.scheduledIntervalDays).toBe(1)
    expect(result.lapseClusterCount).toBe(3)
    expect(result.relearningStep).toBe(0)
    expect(result.pendingIntervalDays).toBeNull()
  })
})

describe('correct answer resets lapse clustering', () => {
  it('clears lapseClusterCount on a correct review', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 2, lastLapseAt: daysAgo(0.1),
    })
    const result = scheduleNext(state, 'good', { now: NOW })
    expect(result.lapseClusterCount).toBe(0)
  })
})

describe('MAX_INTERVAL_DAYS cap', () => {
  it('never schedules an interval beyond the cap, even for a huge "easy" jump', () => {
    const state = baseState({ intervalDays: 2000, scheduledIntervalDays: 2000, lastReviewedAt: daysAgo(2000) })
    const result = scheduleNext(state, 'easy', { now: NOW })
    expect(result.intervalDays).toBeLessThanOrEqual(1825)
  })
})

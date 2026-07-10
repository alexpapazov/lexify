import { scheduleNext, classifyReviewMode, applyMultiplierDecay, BASE_MULTIPLIER, MIN_EFFECTIVE_MULTIPLIER, acceleratedEffectiveMultiplierRange, ACCEL_MULTIPLIER_RANGE, MULTIPLIER_RANGE } from '../scheduler'
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
    difficulty: null, stability: null, relearning: false, goodStreak: 0, againStreak: 0,
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
    typingMistakeStreak: 0,
    typingFailCycles: 0,
    stage3EnteredDate: null,
    iDontKnowCount: 0,
    accentMistakeCount: 0,
    articleMistakeCount: 0,
    genderMistakeCount: 0,
    typoMistakeCount: 0,
    semanticMistakeCount: 0,
    wrongSynonymCount: 0,
    acceleratedMode: 'none' as const,
    acceleratedLocked: false,
    acceleratedWrongStreak: 0,
    acceleratedPenalty: 0,
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
  it('reduces the current interval by 40% on the first lapse', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(15) }) // overdue
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })

    // AGAIN_REDUCTION = 0.60
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
    // The "ideal" interval is untouched until the loop recovers.
    expect(result.intervalDays).toBe(10)
    expect(result.lapseClusterCount).toBe(1)
    expect(result.relearningStep).toBe(1)
    expect(result.relearn).toBeFalsy()
    expect(result.scheduledIntervalDays).toBeCloseTo(RELEARN_RETRY_DAYS, 6)
    expect(result.dueAt).toBe(addMinutes(NOW, 10))
  })

  it('wrongSeverity is ignored — pending is always currentInterval × 0.60 regardless of severity', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10) })
    const mild   = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0 })
    const severe = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    expect(mild.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
    expect(severe.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
  })

  it('a second close-together lapse still uses the same 40% reduction and increments the cluster', () => {
    const firstLapseAt = daysAgo(0.1) // ~2.4 hours ago — within the 24h window
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      lapseClusterCount: 1, lastLapseAt: firstLapseAt,
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
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
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
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
  it('always reduces currentInterval by 40%, even on an elective (early) lapse', () => {
    const state = baseState({ intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(2) }) // progress = 0.2
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // AGAIN_REDUCTION = 0.60 — elapsed time no longer determines pending
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
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

  it('pending interval has no floor — it can drop below 1 day for very short intervals', () => {
    const state = baseState({ intervalDays: 1, scheduledIntervalDays: 1, lastReviewedAt: daysAgo(0.01) }) // 1-day interval
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 1 })
    // 1 × 0.60 = 0.60 — no floor on the pending interval itself
    expect(result.pendingIntervalDays!).toBeCloseTo(0.60, 3)
  })
})

describe('10-minute relearn loop — recovery and continuation', () => {
  it('recovery: applies Hard/Good/Easy multiplier to the pending interval and exits the loop', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: 4,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
      ease: 2.5,
    })
    const result = scheduleNext(state, 'good', { now: NOW })

    // Good multiplier at pendingInterval=4: 1 + (2.25-1)/(1 + 4/90) ≈ 2.197 → 4 × 2.197 ≈ 8.789
    expect(result.intervalDays).toBeGreaterThan(4)
    expect(result.intervalDays).toBeCloseTo(4 * (1 + 1.25 / (1 + 4 / 90)), 1)
    expect(result.scheduledIntervalDays).toBe(result.intervalDays)
    expect(result.relearningStep).toBe(0)
    expect(result.pendingIntervalDays).toBeNull()
    expect(result.lapseClusterCount).toBe(0)
    expect(result.ease).toBe(2.5) // "good" doesn't change ease
  })

  it('recovery falls back to currentInterval (× multiplier) when no pendingIntervalDays was recorded', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: null,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
    })
    const result = scheduleNext(state, 'good', { now: NOW })
    // Falls back to currentInterval=10, then applies Good multiplier
    expect(result.intervalDays).toBeGreaterThan(10)
  })

  it('continuation: failing the retry again applies another 40% reduction to pending interval', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: 4,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005), // within 24h -> cluster becomes 2
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })

    expect(result.relearningStep).toBe(2)
    expect(result.pendingIntervalDays).toBeCloseTo(4 * 0.60, 3) // 2.40
    expect(result.lapseClusterCount).toBe(2)
    expect(result.intervalDays).toBe(10) // ideal interval untouched
    expect(result.scheduledIntervalDays).toBeCloseTo(RELEARN_RETRY_DAYS, 6)
    expect(result.dueAt).toBe(addMinutes(NOW, 10))
    expect(result.relearn).toBeFalsy()
  })

  it('continuation falls back to currentInterval (× 0.60) when pendingIntervalDays was never recorded', () => {
    const state = baseState({
      intervalDays: 10, scheduledIntervalDays: RELEARN_RETRY_DAYS,
      relearningStep: 1, pendingIntervalDays: null,
      lapseClusterCount: 1, lastLapseAt: daysAgo(0.005),
    })
    const result = scheduleNext(state, 'again', { now: NOW, wrongSeverity: 0.5 })
    // basePending = currentInterval = 10, then × 0.60
    expect(result.pendingIntervalDays).toBeCloseTo(10 * 0.60, 3)
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

describe('accelerated fast-track multipliers', () => {
  const accelState30 = () => baseState({
    intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30),
    acceleratedMode: 'import_known', acceleratedWrongStreak: 0, acceleratedPenalty: 0,
  })

  it('Good at 30 days with full acceleration gives ~90 days', () => {
    const result = scheduleNext(accelState30(), 'good', { now: NOW })
    // baseInterval = max(30, 30) = 30; ideal = 30 × 3.0 = 90 (before decay)
    // decay at 30 days: effective ideal = 1 + (3.0-1) / (1 + 30/90) = 1 + 2/1.333 ≈ 2.5 → 30 × 2.5 = 75
    expect(result.intervalDays).toBeGreaterThan(60)
    expect(result.intervalDays).toBeLessThanOrEqual(95)
  })

  it('Easy at 30 days with full acceleration gives > normal easy', () => {
    const normalState = baseState({ intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30) })
    const accel = scheduleNext(accelState30(), 'easy', { now: NOW })
    const normal = scheduleNext(normalState, 'easy', { now: NOW })
    expect(accel.intervalDays).toBeGreaterThan(normal.intervalDays)
  })

  it('Hard at 30 days with full acceleration gives > normal hard', () => {
    const normalState = baseState({ intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30) })
    const accel = scheduleNext(accelState30(), 'hard', { now: NOW })
    const normal = scheduleNext(normalState, 'hard', { now: NOW })
    expect(accel.intervalDays).toBeGreaterThan(normal.intervalDays)
  })

  it('penalty=3 produces same interval as normal (blend = full normal)', () => {
    const normalState = baseState({ intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30) })
    const penaltyState = baseState({
      intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30),
      acceleratedMode: 'import_known', acceleratedWrongStreak: 0, acceleratedPenalty: 3,
    })
    const normal  = scheduleNext(normalState, 'good', { now: NOW })
    const penalty = scheduleNext(penaltyState, 'good', { now: NOW })
    expect(penalty.intervalDays).toBeCloseTo(normal.intervalDays, 2)
  })

  it('acceleratedWrongStreak=2 falls back to normal multipliers', () => {
    const normalState = baseState({ intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30) })
    const streakState = baseState({
      intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30),
      acceleratedMode: 'import_known', acceleratedWrongStreak: 2, acceleratedPenalty: 0,
    })
    const normal = scheduleNext(normalState, 'good', { now: NOW })
    const streak = scheduleNext(streakState, 'good', { now: NOW })
    expect(streak.intervalDays).toBeCloseTo(normal.intervalDays, 2)
  })

  it('mode=none (after deactivation) uses normal multipliers', () => {
    const normalState = baseState({ intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30) })
    const offState = baseState({
      intervalDays: 30, scheduledIntervalDays: 30, lastReviewedAt: daysAgo(30),
      acceleratedMode: 'none', acceleratedWrongStreak: 0, acceleratedPenalty: 1,
    })
    const normal = scheduleNext(normalState, 'good', { now: NOW })
    const off    = scheduleNext(offState, 'good', { now: NOW })
    expect(off.intervalDays).toBeCloseTo(normal.intervalDays, 2)
  })

  it('acceleratedEffectiveMultiplierRange blends linearly with penalty', () => {
    const r0 = acceleratedEffectiveMultiplierRange('good', 0, 0)
    const r3 = acceleratedEffectiveMultiplierRange('good', 0, 3)
    const rN = { min: MULTIPLIER_RANGE.good.min, ideal: MULTIPLIER_RANGE.good.ideal, max: MULTIPLIER_RANGE.good.max }
    // penalty=0: full accel (3.0 ideal)
    expect(r0.ideal).toBeCloseTo(ACCEL_MULTIPLIER_RANGE.good.ideal, 5)
    // penalty=3: same as normal
    expect(r3.ideal).toBeCloseTo(rN.ideal, 5)
  })

  it('long interval decays accelerated multipliers toward the floor', () => {
    const shortState = baseState({
      intervalDays: 10, scheduledIntervalDays: 10, lastReviewedAt: daysAgo(10),
      acceleratedMode: 'import_known', acceleratedWrongStreak: 0, acceleratedPenalty: 0,
    })
    const longState = baseState({
      intervalDays: 500, scheduledIntervalDays: 500, lastReviewedAt: daysAgo(500),
      acceleratedMode: 'import_known', acceleratedWrongStreak: 0, acceleratedPenalty: 0,
    })
    const shortResult = scheduleNext(shortState, 'good', { now: NOW })
    const longResult  = scheduleNext(longState, 'good', { now: NOW })
    // The ratio new/old should be smaller for the long interval
    const shortRatio = shortResult.intervalDays / 10
    const longRatio  = longResult.intervalDays  / 500
    expect(longRatio).toBeLessThan(shortRatio)
    // And the long-interval accelerated multiplier should be close to normal (decayed)
    expect(longRatio).toBeCloseTo(MULTIPLIER_RANGE.good.ideal * (1 / (1 + 500 / 90)) + 1 - (1 / (1 + 500 / 90)), 0)
  })

  it('MAX_INTERVAL_DAYS cap still applies to accelerated cards', () => {
    const state = baseState({
      intervalDays: 1000, scheduledIntervalDays: 1000, lastReviewedAt: daysAgo(1000),
      acceleratedMode: 'import_known', acceleratedWrongStreak: 0, acceleratedPenalty: 0,
    })
    const result = scheduleNext(state, 'easy', { now: NOW })
    expect(result.intervalDays).toBeLessThanOrEqual(1825)
  })
})

import {
  decideProductionMode,
  TYPED_ACCURACY_WINDOW_SIZE,
  FORCED_TYPED_ON_TYPO_ERROR,
  FORCED_TYPED_ON_LAPSE,
} from '../productionMode'
import type { CardState } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-14T00:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

/** A window of `n` entries with the given accuracy (fraction correct). */
function accuracyWindow(correct: number, total: number): number[] {
  return [...Array(correct).fill(1), ...Array(total - correct).fill(0)]
}

/**
 * Defaults represent a card that is fully "graduated out" of mandatory
 * typing: graduated long ago, plenty of typed reviews, high recent accuracy,
 * a recent typed review, and no forced-typing flags. Individual tests
 * override fields to land in the branch they're checking.
 */
function baseState(overrides: Partial<CardState> = {}): CardState {
  return {
    userId: 'user-1',
    cardId: 'card-1',
    pipelineId: 'pipeline-1',
    currentStepOrder: 0,
    correctInStep: 0,
    graduated: true,
    dueAt: null,
    intervalDays: 30,
    scheduledIntervalDays: 30,
    ease: 2.5,
    difficulty: null, stability: null, relearning: false, goodStreak: 0, againStreak: 0,
    smartIntervalDays: null, smartDueAt: null, acceleratedTypedConfirmed: false,
    reps: 10,
    lapses: 0,
    lastRating: 'good',
    lastReviewedAt: daysAgo(1),
    introducedDate: '2026-01-01',
    lapseClusterCount: 0,
    lastLapseAt: null,
    graduatedAt: daysAgo(30),
    relearningStep: 0,
    pendingIntervalDays: null,
    typedAccuracyWindow: accuracyWindow(20, 20), // 100% accuracy
    typedReviewCount: 10,
    lastTypedReviewAt: daysAgo(1),
    forcedTypedRemaining: 0,
    intervalHistory: [],
    typingMistakeStreak: 0,
    typingFailCycles: 0,
    ...overrides,
  }
}

describe('decideProductionMode — forced typing (highest priority)', () => {
  it('forces typed when forcedTypedRemaining > 0, even if everything else favors self-graded', () => {
    const state = baseState({ forcedTypedRemaining: FORCED_TYPED_ON_TYPO_ERROR })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('forces typed when forcedTypedRemaining is the lapse value too', () => {
    const state = baseState({ forcedTypedRemaining: FORCED_TYPED_ON_LAPSE })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('forces typed when the most recent rating was "hard"', () => {
    const state = baseState({ lastRating: 'hard' })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('forces typed when there has never been a typed review', () => {
    const state = baseState({ lastTypedReviewAt: null, typedReviewCount: 0 })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('forces typed when the last typed review was 90+ days ago', () => {
    const state = baseState({ lastTypedReviewAt: daysAgo(91) })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('does not force typed for a typed review just under the 90-day threshold', () => {
    const state = baseState({ lastTypedReviewAt: daysAgo(89) })
    // With everything else favoring self-graded and rng always above any
    // probability threshold, this should fall through to self-graded.
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('self-graded')
  })
})

describe('decideProductionMode — mandatory typing window since (re)graduation', () => {
  it('forces typed when fewer than 14 days have passed since graduation', () => {
    const state = baseState({ graduatedAt: daysAgo(5) })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('does not force typed once 14+ days have passed (all else favorable)', () => {
    const state = baseState({ graduatedAt: daysAgo(14) })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('self-graded')
  })

  it('forces typed when fewer than 4 typed reviews have happened', () => {
    const state = baseState({ typedReviewCount: 3 })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('does not force typed once 4+ typed reviews have happened (all else favorable)', () => {
    const state = baseState({ typedReviewCount: 4 })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('self-graded')
  })

  it('forces typed when recent typed accuracy is below 85%', () => {
    const state = baseState({ typedAccuracyWindow: accuracyWindow(16, 20) }) // 80%
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('treats an empty accuracy window as 0% accuracy (forces typed)', () => {
    const state = baseState({ typedAccuracyWindow: [], typedReviewCount: 0, lastTypedReviewAt: null })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })

  it('a null graduatedAt counts as 0 days since graduation (forces typed)', () => {
    const state = baseState({ graduatedAt: null })
    expect(decideProductionMode(state, NOW, () => 0.99)).toBe('typed')
  })
})

describe('decideProductionMode — probabilistic typed rate by accuracy band', () => {
  it('85-94% accuracy: ~35% typed — rng below the threshold picks typed', () => {
    const state = baseState({ typedAccuracyWindow: accuracyWindow(18, 20) }) // 90%
    expect(decideProductionMode(state, NOW, () => 0.2)).toBe('typed')
  })

  it('85-94% accuracy: ~35% typed — rng above the threshold picks self-graded', () => {
    const state = baseState({ typedAccuracyWindow: accuracyWindow(18, 20) }) // 90%
    expect(decideProductionMode(state, NOW, () => 0.5)).toBe('self-graded')
  })

  it('>=95% accuracy: ~15% typed — rng below the threshold picks typed', () => {
    const state = baseState({ typedAccuracyWindow: accuracyWindow(19, 20) }) // 95%
    expect(decideProductionMode(state, NOW, () => 0.1)).toBe('typed')
  })

  it('>=95% accuracy: ~15% typed — rng above the threshold picks self-graded', () => {
    const state = baseState({ typedAccuracyWindow: accuracyWindow(19, 20) }) // 95%
    expect(decideProductionMode(state, NOW, () => 0.5)).toBe('self-graded')
  })

  it('uses Math.random by default when no rng is supplied', () => {
    const state = baseState()
    const result = decideProductionMode(state, NOW)
    expect(['typed', 'self-graded']).toContain(result)
  })
})

describe('TYPED_ACCURACY_WINDOW_SIZE', () => {
  it('caps the relevant accuracy window at 20 entries', () => {
    expect(TYPED_ACCURACY_WINDOW_SIZE).toBe(20)
  })
})

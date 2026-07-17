import { classifyReviewMode, graduationIntervalRange } from '../scheduler'
import { initialCardState } from '../pipeline'
import { DEFAULT_SCHEDULER_PARAMS } from '@/domain'
import type { CardState } from '@/domain'

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = new Date('2026-06-14T00:00:00.000Z')

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * DAY_MS).toISOString()
}

// Derive from the canonical initialCardState so the fixture stays complete as CardState grows.
function baseState(overrides: Partial<CardState> = {}): CardState {
  return {
    ...initialCardState('user-1', 'card-1', 'pipeline-1'),
    graduated: true,
    intervalDays: 10,
    scheduledIntervalDays: 10,
    reps: 5,
    lastRating: 'good',
    lastReviewedAt: daysAgo(10),
    graduatedAt: daysAgo(30),
    ...overrides,
  }
}

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

  it('prefers a past due date over interval math (split typed/recall tracks)', () => {
    // A long recall interval would look elective by interval math, but a past typedDueAt wins.
    const state = baseState({ scheduledIntervalDays: 90, lastReviewedAt: daysAgo(2), typedDueAt: daysAgo(1) })
    expect(classifyReviewMode(state, NOW)).toBe('due')
  })
})

describe('graduationIntervalRange', () => {
  it('buckets by struggle count and shrinks as errors grow', () => {
    const p = DEFAULT_SCHEDULER_PARAMS
    expect(graduationIntervalRange(0)).toEqual([p.gradInterval0errMin, p.gradInterval0errMax])
    expect(graduationIntervalRange(1)).toEqual([p.gradInterval1errMin, p.gradInterval1errMax])
    expect(graduationIntervalRange(3)).toEqual([p.gradInterval3errMin, p.gradInterval3errMax])
    // Negative / zero clamps to the 0-error bucket; 8+ all share the most-struggled bucket.
    expect(graduationIntervalRange(-2)).toEqual([p.gradInterval0errMin, p.gradInterval0errMax])
    expect(graduationIntervalRange(20)).toEqual([p.gradInterval8errMin, p.gradInterval8errMax])
    // Ideal (midpoint) is non-increasing as errors rise.
    const ideal = (e: number) => { const [a, b] = graduationIntervalRange(e); return Math.floor((a + b) / 2) }
    expect(ideal(0)).toBeGreaterThanOrEqual(ideal(2))
    expect(ideal(2)).toBeGreaterThanOrEqual(ideal(4))
  })
})

import { LONG_TERM_THRESHOLD_DAYS, maturityPhase, rowSightingEligible, laneSightingEligible } from '../implicitCredit'
import { initialCardState } from '../pipeline'
import type { CardState } from '@/domain'

const NOW = new Date('2026-11-06T12:00:00.000Z')
const iso = (daysFromNow: number) => new Date(NOW.getTime() + daysFromNow * 86_400_000).toISOString()

function grad(overrides: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u', 'c', 'p'), graduated: true, ...overrides }
}

describe('maturityPhase — two phases, split at 60 days (user decision: no medium band)', () => {
  it('long-term at and past the threshold, short-term below, short-term when unscheduled', () => {
    expect(LONG_TERM_THRESHOLD_DAYS).toBe(60)
    expect(maturityPhase(60)).toBe('long_term')
    expect(maturityPhase(90)).toBe('long_term')
    expect(maturityPhase(59.9)).toBe('short_term')
    expect(maturityPhase(null)).toBe('short_term')
    expect(maturityPhase(undefined)).toBe('short_term')
  })
})

describe('rowSightingEligible', () => {
  it('requires graduated, awake, out of the relearn loop', () => {
    expect(rowSightingEligible(grad(), NOW)).toBe(true)
    expect(rowSightingEligible(grad({ graduated: false }), NOW)).toBe(false)
    expect(rowSightingEligible(grad({ dormant: true }), NOW)).toBe(false)
    expect(rowSightingEligible(grad({ relearning: true }), NOW)).toBe(false)
    expect(rowSightingEligible(grad({ relearningStep: 1 }), NOW)).toBe(false)
  })

  it('caps credit at one per row per day (20h gap)', () => {
    const fiveHoursAgo = new Date(NOW.getTime() - 5 * 3_600_000).toISOString()
    const yesterday    = new Date(NOW.getTime() - 25 * 3_600_000).toISOString()
    expect(rowSightingEligible(grad({ lastImplicitAt: fiveHoursAgo }), NOW)).toBe(false)
    expect(rowSightingEligible(grad({ lastImplicitAt: yesterday }), NOW)).toBe(true)
  })
})

describe('laneSightingEligible', () => {
  it('long-term + scheduled in the future = eligible', () => {
    expect(laneSightingEligible({ intervalDays: 90, dueAt: iso(30) }, NOW)).toBe(true)
  })
  it('short-term lanes earn nothing from a sighting', () => {
    expect(laneSightingEligible({ intervalDays: 30, dueAt: iso(10) }, NOW)).toBe(false)
  })
  it('an overdue lane stays due — a sighting never stands in for an owed review', () => {
    expect(laneSightingEligible({ intervalDays: 90, dueAt: iso(-1) }, NOW)).toBe(false)
  })
  it('an unscheduled lane is ineligible', () => {
    expect(laneSightingEligible({ intervalDays: 90, dueAt: null }, NOW)).toBe(false)
  })
})

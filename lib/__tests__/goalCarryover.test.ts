import { carriedGoal, plannedGoalSum, fullDebtGoal, isAutoGraduated, fullDebtExemptionAdjustment } from '../goalCarryover'

const base = { baseGoal: 20, yesterdayGoal: 20, yesterdayCount: 20, carryShortfall: false, carrySurplus: false }

describe('carriedGoal', () => {
  it('leaves the goal alone when both toggles are off', () => {
    expect(carriedGoal({ ...base, yesterdayCount: 5 })).toEqual({ goal: 20, delta: 0 })
    expect(carriedGoal({ ...base, yesterdayCount: 40 })).toEqual({ goal: 20, delta: 0 })
  })

  it('adds yesterday’s shortfall when carryShortfall is on', () => {
    expect(carriedGoal({ ...base, yesterdayCount: 12, carryShortfall: true }))
      .toEqual({ goal: 28, delta: 8 })
  })

  it('subtracts yesterday’s surplus when carrySurplus is on', () => {
    expect(carriedGoal({ ...base, yesterdayCount: 32, carrySurplus: true }))
      .toEqual({ goal: 8, delta: -12 })
  })

  it('applies only the toggle matching the direction of the miss', () => {
    // Surplus yesterday, but only the shortfall toggle is on -> no credit.
    expect(carriedGoal({ ...base, yesterdayCount: 32, carryShortfall: true }))
      .toEqual({ goal: 20, delta: 0 })
    // Shortfall yesterday, but only the surplus toggle is on -> no debt.
    expect(carriedGoal({ ...base, yesterdayCount: 12, carrySurplus: true }))
      .toEqual({ goal: 20, delta: 0 })
  })

  it('treats a rest day as neither credit nor debt', () => {
    const both = { carryShortfall: true, carrySurplus: true }
    expect(carriedGoal({ ...base, ...both, yesterdayGoal: null, yesterdayCount: 0 }))
      .toEqual({ goal: 20, delta: 0 })
    // Studied hard on a rest day -> still no credit, there was no target to beat.
    expect(carriedGoal({ ...base, ...both, yesterdayGoal: null, yesterdayCount: 40 }))
      .toEqual({ goal: 20, delta: 0 })
    // An explicit zero goal behaves the same as null.
    expect(carriedGoal({ ...base, ...both, yesterdayGoal: 0, yesterdayCount: 40 }))
      .toEqual({ goal: 20, delta: 0 })
  })

  it('floors at zero and reports only the delta that actually landed', () => {
    // 50 surplus against a goal of 20 can only credit 20 of it.
    expect(carriedGoal({ ...base, yesterdayCount: 70, carrySurplus: true }))
      .toEqual({ goal: 0, delta: -20 })
  })

  it('is a no-op when yesterday exactly hit the goal', () => {
    expect(carriedGoal({ ...base, carryShortfall: true, carrySurplus: true }))
      .toEqual({ goal: 20, delta: 0 })
  })
})

describe('plannedGoalSum', () => {
  it('sums a constant daily goal across the range (inclusive)', () => {
    // 2026-07-20 (Mon) through 2026-07-22 (Wed) = 3 days × 10.
    expect(plannedGoalSum(() => 10, '2026-07-20', '2026-07-22')).toBe(30)
  })
  it('skips rest days (weekday goal 0)', () => {
    // goal only on weekdays (Mon–Fri = 1..5); 2026-07-18 Sat + 2026-07-19 Sun are rest.
    const g = (wd: number) => (wd >= 1 && wd <= 5 ? 10 : 0)
    expect(plannedGoalSum(g, '2026-07-18', '2026-07-19')).toBe(0)   // Sat+Sun
    expect(plannedGoalSum(g, '2026-07-17', '2026-07-20')).toBe(20)  // Fri(10)+Sat(0)+Sun(0)+Mon(10)
  })
  it('is 0 when the range is empty (since after through)', () => {
    expect(plannedGoalSum(() => 10, '2026-07-22', '2026-07-21')).toBe(0)
  })
})

describe('fullDebtGoal', () => {
  it('piles the whole running shortfall onto today', () => {
    // planned 100 over the span, only 70 done → owe 30 on top of a base 20.
    expect(fullDebtGoal({ baseGoal: 20, plannedThroughYesterday: 100, gradsThroughYesterday: 70 }))
      .toEqual({ goal: 50, delta: 30 })
  })
  it('rolls a big surplus forward across multiple days (down to 0)', () => {
    // 40 ahead against a base 20 → today needs nothing, and it stays credited.
    expect(fullDebtGoal({ baseGoal: 20, plannedThroughYesterday: 100, gradsThroughYesterday: 140 }))
      .toEqual({ goal: 0, delta: -20 })
  })
  it('leaves the goal alone when exactly on pace', () => {
    expect(fullDebtGoal({ baseGoal: 20, plannedThroughYesterday: 100, gradsThroughYesterday: 100 }))
      .toEqual({ goal: 20, delta: 0 })
  })
})

describe('isAutoGraduated', () => {
  it('excludes both auto-graduate paths from goal counts', () => {
    expect(isAutoGraduated('import_known')).toBe(true)   // fast-tracked import
    expect(isAutoGraduated('bulk_known')).toBe(true)     // bulk "I already knew these"
  })
  it('counts normally-learned cards', () => {
    expect(isAutoGraduated('none')).toBe(false)
    expect(isAutoGraduated(null)).toBe(false)
    expect(isAutoGraduated(undefined)).toBe(false)
  })
  it('excludes any future mode by default rather than silently counting it', () => {
    expect(isAutoGraduated('some_new_mode')).toBe(true)
  })
})

describe('fullDebtExemptionAdjustment', () => {
  // A goal of 10 every day; the exempt day is 2026-07-22.
  const base = {
    skipShortfallDays: [] as string[], skipSurplusDays: [] as string[],
    goalForDay: () => 10, since: '2026-07-01', through: '2026-07-31',
  }

  it('cancels a waived day’s deficit so it never rolls forward', () => {
    // Did 4 of 10 → normally −6 debt; waived → 0.
    const adj = fullDebtExemptionAdjustment({ ...base, skipShortfallDays: ['2026-07-22'], gradsForDay: () => 4 })
    expect(adj).toBe(6)
  })

  it('cancels a waived day’s surplus so it never banks credit', () => {
    // Did 25 of 10 → normally +15 credit; waived → 0.
    const adj = fullDebtExemptionAdjustment({ ...base, skipSurplusDays: ['2026-07-22'], gradsForDay: () => 25 })
    expect(adj).toBe(-15)
  })

  it('only waives the direction that was checked', () => {
    // Shortfall waived, but the day was a SURPLUS → nothing to cancel.
    expect(fullDebtExemptionAdjustment({ ...base, skipShortfallDays: ['2026-07-22'], gradsForDay: () => 25 })).toBe(0)
    // Surplus waived, but the day was a DEFICIT → nothing to cancel.
    expect(fullDebtExemptionAdjustment({ ...base, skipSurplusDays: ['2026-07-22'], gradsForDay: () => 4 })).toBe(0)
  })

  it('ignores days outside the window and rest days', () => {
    expect(fullDebtExemptionAdjustment({ ...base, skipShortfallDays: ['2026-06-01'], gradsForDay: () => 0 })).toBe(0)
    expect(fullDebtExemptionAdjustment({ ...base, skipShortfallDays: ['2026-07-22'], goalForDay: () => 0, gradsForDay: () => 0 })).toBe(0)
  })

  it('feeds through fullDebtGoal to leave today’s goal unchanged', () => {
    // Planned 100, did 94 (a 6-card shortfall on the waived day) → without the waiver today's goal
    // would be 10 + 6 = 16; with it, back to the plain base.
    const adj = fullDebtExemptionAdjustment({ ...base, skipShortfallDays: ['2026-07-22'], gradsForDay: () => 4 })
    expect(fullDebtGoal({ baseGoal: 10, plannedThroughYesterday: 100, gradsThroughYesterday: 94 }).goal).toBe(16)
    expect(fullDebtGoal({ baseGoal: 10, plannedThroughYesterday: 100, gradsThroughYesterday: 94, exemptionAdjustment: adj }).goal).toBe(10)
  })
})

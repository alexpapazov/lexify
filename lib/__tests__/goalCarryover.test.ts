import { carriedGoal, plannedGoalSum, fullDebtGoal, isAutoGraduated, fullDebtExemptionAdjustment, owedGoalForDate, capGoal, MAX_GOAL_MULTIPLE, goalStanding, effectiveDebtSince } from '../goalCarryover'

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
  const wd = (d: string) => new Date(d + 'T12:00:00Z').getUTCDay()
  it('sums a constant daily goal across the range (inclusive)', () => {
    // 2026-07-20 (Mon) through 2026-07-22 (Wed) = 3 days × 10.
    expect(plannedGoalSum(() => 10, '2026-07-20', '2026-07-22')).toBe(30)
  })
  it('skips rest days (goal 0)', () => {
    const g = (d: string) => (wd(d) >= 1 && wd(d) <= 5 ? 10 : 0)
    expect(plannedGoalSum(g, '2026-07-18', '2026-07-19')).toBe(0)   // Sat+Sun
    expect(plannedGoalSum(g, '2026-07-17', '2026-07-20')).toBe(20)  // Fri(10)+Sat(0)+Sun(0)+Mon(10)
  })
  it('is 0 when the range is empty (since after through)', () => {
    expect(plannedGoalSum(() => 10, '2026-07-22', '2026-07-21')).toBe(0)
  })
})

describe('owedGoalForDate (defer "move to tomorrow")', () => {
  const configured = () => 10  // goal 10 every weekday
  const deferred = (set: string[]) => (d: string) => set.includes(d)
  it('owes the configured goal on a normal day', () => {
    expect(owedGoalForDate('2026-07-22', configured, deferred([]))).toBe(10)
  })
  it('owes 0 on a day it was deferred', () => {
    expect(owedGoalForDate('2026-07-22', configured, deferred(['2026-07-22']))).toBe(0)
  })
  it("adds yesterday's goal when yesterday was deferred", () => {
    // Jul 21 deferred → its 10 lands on Jul 22, on top of Jul 22's own 10 = 20.
    expect(owedGoalForDate('2026-07-22', configured, deferred(['2026-07-21']))).toBe(20)
  })
  it('conserves the total across the shift (deferred day 0, next day double)', () => {
    const isDef = deferred(['2026-07-21'])
    const total = owedGoalForDate('2026-07-21', configured, isDef) + owedGoalForDate('2026-07-22', configured, isDef)
    expect(total).toBe(20)  // same as two undeferred days: 10 + 10
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

describe('capGoal — a day can never exceed 2.5x its configured goal', () => {
  it('caps at floor(base * 2.5) and leaves smaller goals alone', () => {
    expect(MAX_GOAL_MULTIPLE).toBe(2.5)
    expect(capGoal(33, 8)).toBe(20)   // the reported case: 8/day pair showing 33
    expect(capGoal(20, 8)).toBe(20)   // exactly at the ceiling
    expect(capGoal(12, 8)).toBe(12)   // under the ceiling — untouched
    expect(capGoal(0, 8)).toBe(0)
  })

  it('floors rather than rounds, so it never lands strictly above the multiple', () => {
    expect(capGoal(99, 5)).toBe(12)   // 5 * 2.5 = 12.5 -> 12, not 13
    expect(capGoal(99, 3)).toBe(7)    // 3 * 2.5 = 7.5  -> 7
  })

  it('a rest day (base 0) stays 0 — its share of the debt rolls forward', () => {
    expect(capGoal(40, 0)).toBe(0)
  })

  it('applies to both carryover modes', () => {
    expect(fullDebtGoal({ baseGoal: 8, plannedThroughYesterday: 25, gradsThroughYesterday: 0 }).goal).toBe(20)
    expect(carriedGoal({ baseGoal: 8, yesterdayGoal: 40, yesterdayCount: 0, carryShortfall: true, carrySurplus: false }).goal).toBe(20)
  })

  it('reports the delta that actually landed, not the raw debt', () => {
    // 25 owed on top of a base of 8 would be +25; only +12 fits under the cap.
    expect(fullDebtGoal({ baseGoal: 8, plannedThroughYesterday: 25, gradsThroughYesterday: 0 }).delta).toBe(12)
  })

  it('a surplus still lowers the goal (the cap is a ceiling only)', () => {
    expect(carriedGoal({ baseGoal: 8, yesterdayGoal: 8, yesterdayCount: 14, carryShortfall: false, carrySurplus: true }).goal).toBe(2)
  })
})

describe('capped debt DRAINS across days rather than being forgiven', () => {
  it('an 8/day pair owing 25 runs 20 -> 20 -> 9 -> 8', () => {
    const baseGoal = 8
    // Stateless model: debt is (grads - planned) recomputed from history each day.
    let planned = 25, grads = 0          // 25 owed, nothing done
    const shown: number[] = []
    for (let day = 0; day < 5; day++) {
      const goal = fullDebtGoal({ baseGoal, plannedThroughYesterday: planned, gradsThroughYesterday: grads }).goal
      shown.push(goal)
      // The learner completes exactly the shown goal; history grows by the CONFIGURED base, which is
      // what keeps the withheld remainder owed.
      grads   += goal
      planned += baseGoal
    }
    expect(shown).toEqual([20, 20, 9, 8, 8])
  })

  it('the withheld amount is deferred, not deleted (totals reconcile)', () => {
    const baseGoal = 8
    let planned = 25, grads = 0
    let done = 0
    for (let day = 0; day < 4; day++) {
      const goal = fullDebtGoal({ baseGoal, plannedThroughYesterday: planned, gradsThroughYesterday: grads }).goal
      done += goal; grads += goal; planned += baseGoal
    }
    // 25 backlog + 4 days x 8 = 57 owed over the window; all of it eventually assigned.
    expect(done).toBe(57)
  })
})

describe('goalStanding — the running balance since full debt was enabled', () => {
  const base = { plannedThroughYesterday: 0, gradsThroughYesterday: 0, todayGoal: 0, todayGrads: 0 }

  it('is 0 when everything owed has been done', () => {
    expect(goalStanding({ ...base, plannedThroughYesterday: 40, gradsThroughYesterday: 40 })).toBe(0)
  })

  it('is negative by exactly the number of cards owed', () => {
    expect(goalStanding({ ...base, plannedThroughYesterday: 50, gradsThroughYesterday: 20 })).toBe(-30)
  })

  it('is positive when ahead', () => {
    expect(goalStanding({ ...base, plannedThroughYesterday: 20, gradsThroughYesterday: 35 })).toBe(15)
  })

  it("counts today's goal as owed and today's work as done", () => {
    // Fresh day, nothing studied yet: you are down by today's goal.
    expect(goalStanding({ ...base, todayGoal: 12 })).toBe(-12)
    // Half of it done.
    expect(goalStanding({ ...base, todayGoal: 12, todayGrads: 5 })).toBe(-7)
    // Finished, and level.
    expect(goalStanding({ ...base, todayGoal: 12, todayGrads: 12 })).toBe(0)
    // Overshot.
    expect(goalStanding({ ...base, todayGoal: 12, todayGrads: 20 })).toBe(8)
  })

  it('combines history with today', () => {
    expect(goalStanding({
      plannedThroughYesterday: 100, gradsThroughYesterday: 70, todayGoal: 10, todayGrads: 4,
    })).toBe(-36)
  })

  it('treats a negative today goal as zero owed rather than as credit', () => {
    expect(goalStanding({ ...base, todayGoal: -5, todayGrads: 3 })).toBe(3)
  })

  it('applies the exemption adjustment the same way fullDebtGoal does', () => {
    // 30 owed, 0 done, but the whole shortfall was waived.
    expect(goalStanding({
      ...base, plannedThroughYesterday: 30, gradsThroughYesterday: 0, exemptionAdjustment: 30,
    })).toBe(0)
  })

  it('agrees with fullDebtGoal about the direction of the carryover', () => {
    const planned = 50, grads = 20, baseGoal = 10
    const standing = goalStanding({ plannedThroughYesterday: planned, gradsThroughYesterday: grads, todayGoal: baseGoal, todayGrads: 0 })
    const { goal } = fullDebtGoal({ baseGoal, plannedThroughYesterday: planned, gradsThroughYesterday: grads })
    // Behind on both readings; the goal is raised (capped), the standing is negative.
    expect(standing).toBeLessThan(0)
    expect(goal).toBeGreaterThan(baseGoal)
  })
})

describe('effectiveDebtSince', () => {
  it('is the global date when the language has no reset', () => {
    expect(effectiveDebtSince('2026-07-01', {}, 'es|en')).toBe('2026-07-01')
    expect(effectiveDebtSince('2026-07-01', null, 'es|en')).toBe('2026-07-01')
    expect(effectiveDebtSince('2026-07-01', undefined, 'es|en')).toBe('2026-07-01')
  })

  it('uses a later per-language reset', () => {
    expect(effectiveDebtSince('2026-07-01', { 'es|en': '2026-07-20' }, 'es|en')).toBe('2026-07-20')
  })

  it('ignores a per-language reset older than the global enable date', () => {
    // A global "reset all" must not be undone by a stale per-pair entry from before it.
    expect(effectiveDebtSince('2026-07-25', { 'es|en': '2026-07-10' }, 'es|en')).toBe('2026-07-25')
  })

  it('only affects the language it names', () => {
    const resets = { 'es|en': '2026-07-20' }
    expect(effectiveDebtSince('2026-07-01', resets, 'ko|en')).toBe('2026-07-01')
  })

  it('is null when full debt was never enabled, whatever the resets say', () => {
    expect(effectiveDebtSince(null, { 'es|en': '2026-07-20' }, 'es|en')).toBeNull()
  })

  it('a reset dated today zeroes the balance — planned and grads both sum to nothing', () => {
    const today = '2026-07-31'
    const since = effectiveDebtSince('2026-07-01', { 'es|en': today }, 'es|en')!
    const yesterday = '2026-07-30'
    // plannedGoalSum over [today .. yesterday] is an empty range.
    expect(plannedGoalSum(() => 8, since, yesterday)).toBe(0)
    // …so today's goal falls back to base, which is the whole point of the reset button.
    expect(fullDebtGoal({ baseGoal: 8, plannedThroughYesterday: 0, gradsThroughYesterday: 0 }).goal).toBe(8)
  })
})

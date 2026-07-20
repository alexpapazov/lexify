import { carriedGoal } from '../goalCarryover'

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

import { climbInProgress } from '../climbProgress'

describe('climbInProgress', () => {
  it('is false for nothing at all', () => {
    expect(climbInProgress(undefined)).toBe(false)
    expect(climbInProgress(null)).toBe(false)
  })

  it('ladder: past the first rung is in progress; sitting on rung 0 untouched is not', () => {
    expect(climbInProgress({ rungIndex: 1, rungHistory: [0, 1] })).toBe(true)
    expect(climbInProgress({ rungIndex: 0, rungHistory: [0] })).toBe(false)
  })

  it('ladder: DROPPED BACK to rung 0 stays in progress — the history shows the trip', () => {
    expect(climbInProgress({ rungIndex: 0, rungHistory: [0, 1, 0] })).toBe(true)
  })

  it('ladder: a climb saved before rungHistory existed falls back to the live rung', () => {
    expect(climbInProgress({ rungIndex: 2 })).toBe(true)
    expect(climbInProgress({ rungIndex: 0 })).toBe(false)
  })

  it('pathway: having moved at least once is in progress — this was invisible before', () => {
    expect(climbInProgress({ stateId: 's1', history: ['s0', 's1'] })).toBe(true)
    expect(climbInProgress({ stateId: 's0', history: ['s0'] })).toBe(false)
  })

  it('pathway: falling back to the initial state stays in progress', () => {
    expect(climbInProgress({ stateId: 's0', history: ['s0', 's1', 's0'] })).toBe(true)
  })

  it('a graduated climb is not "in progress" whatever its history says', () => {
    expect(climbInProgress({ graduated: true, rungIndex: 3, rungHistory: [0, 1, 2, 3] })).toBe(false)
    expect(climbInProgress({ graduated: true, stateId: 'grad', history: ['s0', 's1', 'grad'] })).toBe(false)
  })
})

import type { Ladder, Rung, RungType, RungDirection } from '@/domain'
import {
  initialClimbState, reviewRung, applyWindow, isWindowExpired, easyInterval,
  CLIMB_WINDOW_MS, type ClimbState, type RungAttemptOutcome,
} from '@/engine/ladderEngine'

let idc = 0
function rung(over: Partial<Rung> = {}): Rung {
  return { id: `r${idc++}`, type: 'typing', direction: 'produce_target', selfRated: false,
    intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [], ...over }
}
const NOW = 1_000_000_000_000

/** Drives a sequence of outcomes from the initial state, returning the final state. */
function run(ladder: Ladder, outcomes: RungAttemptOutcome[], now = NOW): ClimbState {
  let s = initialClimbState()
  for (const o of outcomes) s = reviewRung(ladder, s, o, now).state
  return s
}

describe('auto-checked rung', () => {
  it('advances after N passes in a row; a miss resets the streak', () => {
    const l: Ladder = { rungs: [rung({ advanceTimes: 2, advanceInARow: true }), rung()] }
    expect(run(l, ['pass', 'pass']).rungIndex).toBe(1)
    expect(run(l, ['pass', 'miss']).rungIndex).toBe(0)          // streak reset
    expect(run(l, ['pass', 'miss', 'pass', 'pass']).rungIndex).toBe(1)
  })

  it('"total" mode does not reset on a miss', () => {
    const l: Ladder = { rungs: [rung({ advanceTimes: 2, advanceInARow: false }), rung()] }
    expect(run(l, ['pass', 'miss', 'pass']).rungIndex).toBe(1)
  })
})

describe('interval-setting rung (Anki graduation)', () => {
  const l: Ladder = { rungs: [rung({ selfRated: true, intervalInit: true })] }

  it('Good twice in a row graduates at 1 day', () => {
    const after1 = reviewRung(l, initialClimbState(), 'good', NOW)
    expect(after1.advanced).toBe(false)
    const s = run(l, ['good', 'good'])
    expect(s.graduated).toBe(true)
    expect(s.targetInterval).toEqual({ min: 1, max: 1 })
  })

  it('Good must be twice IN A ROW (good, hard, good, good)', () => {
    expect(run(l, ['good', 'hard', 'good']).graduated).toBe(false)
    expect(run(l, ['good', 'hard', 'good', 'good']).graduated).toBe(true)
  })

  it.each([
    [['easy'], { min: 3, max: 4 }],
    [['good', 'easy'], { min: 3, max: 4 }],
    [['again', 'good', 'easy'], { min: 3, max: 3 }],
    [['hard', 'easy'], { min: 2, max: 3 }],
    [['again', 'hard', 'easy'], { min: 2, max: 2 }],
  ])('Easy after %j → %j', (seq, expected) => {
    const s = run(l, seq as RungAttemptOutcome[])
    expect(s.graduated).toBe(true)
    expect(s.targetInterval).toEqual(expected)
  })
})

describe('easyInterval() directly', () => {
  it('never goes below 2 days', () => {
    expect(easyInterval(5, 'hard')).toEqual({ min: 2, max: 2 })
  })
})

describe('self-rated non-init rung', () => {
  it('advances on the chosen rating ("one Easy")', () => {
    const l: Ladder = { rungs: [rung({ selfRated: true, advanceRating: 'easy', advanceTimes: 1 }), rung()] }
    expect(reviewRung(l, initialClimbState(), 'good', NOW).state.rungIndex).toBe(0) // Good doesn't advance
    expect(reviewRung(l, initialClimbState(), 'easy', NOW).state.rungIndex).toBe(1) // Easy advances
  })
})

describe('drop-back rules', () => {
  it('a miss twice sends the card back to a chosen rung', () => {
    const first = rung()
    const last = rung({ dropBacks: [{ on: 'miss', times: 2, toRungId: first.id }] })
    const l: Ladder = { rungs: [first, rung(), last] }
    let s = initialClimbState(); s = { ...s, rungIndex: 2 }
    s = reviewRung(l, s, 'miss', NOW).state
    expect(s.rungIndex).toBe(2)               // one miss, no drop yet
    const r = reviewRung(l, s, 'miss', NOW)
    expect(r.droppedBackTo).toBe(0)
    expect(r.state.rungIndex).toBe(0)
  })
})

describe('12-hour window', () => {
  it('resets to the first rung once 12h have passed since the first rung cleared', () => {
    const l: Ladder = { rungs: [rung(), rung({ selfRated: true, intervalInit: true }), rung({ direction: 'produce_native', type: 'self_graded', selfRated: true, intervalInit: true })] }
    let s = reviewRung(l, initialClimbState(), 'pass', NOW).state   // clears rung 1 → window starts
    expect(s.startedAt).toBe(NOW)
    expect(isWindowExpired(s, NOW + CLIMB_WINDOW_MS + 1)).toBe(true)
    expect(applyWindow(s, NOW + CLIMB_WINDOW_MS + 1).rungIndex).toBe(0)
    expect(applyWindow(s, NOW + 1000).rungIndex).toBe(s.rungIndex)  // still within window
  })
})

describe('full climb & independent intervals', () => {
  it('graduates when the last rung is cleared, each direction with its own interval', () => {
    const l: Ladder = { rungs: [
      rung({ type: 'mcq', direction: 'produce_native', selfRated: false }),
      rung({ type: 'typing', direction: 'produce_target', selfRated: true, intervalInit: true }),
      rung({ type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true }),
    ] }
    // pass MCQ → target init: good,good (1 day) → native init: easy first try (3–4)
    const s = run(l, ['pass', 'good', 'good', 'easy'])
    expect(s.graduated).toBe(true)
    expect(s.targetInterval).toEqual({ min: 1, max: 1 })
    expect(s.nativeInterval).toEqual({ min: 3, max: 4 })
  })

  it('with no interval-setting rungs, both directions graduate at a flat 1 day', () => {
    const l: Ladder = { rungs: [rung({ type: 'mcq', selfRated: false })] }
    const s = run(l, ['pass'])
    expect(s.graduated).toBe(true)
    expect(s.targetInterval).toEqual({ min: 1, max: 1 })
    expect(s.nativeInterval).toEqual({ min: 1, max: 1 })
  })
})

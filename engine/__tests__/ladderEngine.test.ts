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

  it('auto-checked OR rules: "2 pass in a row OR 3 total" advances on either', () => {
    const l: Ladder = { rungs: [rung({ selfRated: false, advanceRules: [
      { times: 2, inARow: true },
      { times: 3, inARow: false },
    ] }), rung()] }
    expect(run(l, ['pass']).rungIndex).toBe(0)              // one pass — not yet
    expect(run(l, ['pass', 'pass']).rungIndex).toBe(1)      // two in a row → advance
    expect(run(l, ['pass', 'miss', 'pass', 'pass']).rungIndex).toBe(1)  // streak → advance
    expect(run(l, ['pass', 'miss', 'pass', 'miss', 'pass']).rungIndex).toBe(1) // 3 total → advance
  })

  it('OR rules: "1 Easy OR 2 Good in a row" advances on either', () => {
    const l: Ladder = { rungs: [rung({ selfRated: true, advanceRules: [
      { times: 1, inARow: true, minRating: 'easy' },
      { times: 2, inARow: true, minRating: 'good' },
    ] }), rung()] }
    // One Easy → advance immediately.
    expect(reviewRung(l, initialClimbState(), 'easy', NOW).state.rungIndex).toBe(1)
    // One Good → not yet; two Goods in a row → advance.
    expect(run(l, ['good']).rungIndex).toBe(0)
    expect(run(l, ['good', 'good']).rungIndex).toBe(1)
    // A Hard breaks the Good streak → still on rung 0.
    expect(run(l, ['good', 'hard', 'good']).rungIndex).toBe(0)
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

  it('"in a row" drop-back resets on a non-matching outcome', () => {
    const first = rung()
    const last = rung({ dropBacks: [{ on: 'miss', times: 2, inARow: true, toRungId: first.id }] })
    const l: Ladder = { rungs: [first, last] }
    const start: ClimbState = { ...initialClimbState(), rungIndex: 1 }
    // miss, almost, miss → not two misses in a row (almost breaks it) → no drop-back.
    let s = start
    for (const o of ['miss', 'almost', 'miss'] as const) s = reviewRung(l, s, o, NOW).state
    expect(s.rungIndex).toBe(1)
    // one more miss → two in a row → drop back.
    expect(reviewRung(l, s, 'miss', NOW).droppedBackTo).toBe(0)
  })
})

describe('skip-ahead rules', () => {
  it('a clean pass jumps forward to the chosen rung instead of advancing one', () => {
    const r0 = rung(), r1 = rung(), r2 = rung()   // auto-checked (typing)
    r0.skipAheads = [{ on: 'pass', times: 1, toRungId: r2.id }]
    const l: Ladder = { rungs: [r0, r1, r2] }
    // Skip is checked before the normal one-rung advance, so a pass lands on rung 2, bypassing rung 1.
    expect(reviewRung(l, initialClimbState(), 'pass', NOW).state.rungIndex).toBe(2)
  })

  it('an Easy skips further ahead on a self-rated rung', () => {
    const r0 = rung({ selfRated: true }), r1 = rung(), r2 = rung()
    r0.skipAheads = [{ on: 'easy', times: 1, toRungId: r2.id }]
    const l: Ladder = { rungs: [r0, r1, r2] }
    expect(reviewRung(l, initialClimbState(), 'easy', NOW).state.rungIndex).toBe(2)
  })

  it('total-count skip: 2 Good on a rung that only advances on Easy jumps ahead', () => {
    // Rung advances normally only on Easy, so Goods accumulate toward the skip threshold.
    const r0 = rung({ selfRated: true, advanceRules: [{ times: 1, inARow: false, minRating: 'easy' }] })
    const r1 = rung(), r2 = rung()
    r0.skipAheads = [{ on: 'good', times: 2, toRungId: r2.id }]
    const l: Ladder = { rungs: [r0, r1, r2] }
    let s = reviewRung(l, initialClimbState(), 'good', NOW).state
    expect(s.rungIndex).toBe(0)                        // one Good — not enough, doesn't advance
    s = reviewRung(l, s, 'good', NOW).state
    expect(s.rungIndex).toBe(2)                        // two Good total → skip to rung 2
  })

  it('a skip target that is not ahead is ignored (never jumps backward)', () => {
    const r0 = rung(), r1 = rung()
    r1.skipAheads = [{ on: 'pass', times: 1, toRungId: r0.id }]  // points backward
    const l: Ladder = { rungs: [r0, r1] }
    const start: ClimbState = { ...initialClimbState(), rungIndex: 1 }
    const res = reviewRung(l, start, 'pass', NOW)
    expect(res.state.rungIndex).not.toBe(0)   // does not drop back via a skip rule
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

describe('rung history', () => {
  it('records every rung occupied, drop-backs included (1→2→3→4→3→4→5)', () => {
    const r0 = rung(), r1 = rung(), r2 = rung(), r3b = rung(), r4 = rung()
    const r3 = { ...r3b, dropBacks: [{ on: 'miss' as const, times: 1, inARow: true, toRungId: r2.id }] }
    const l: Ladder = { rungs: [r0, r1, r2, r3, r4] }
    // pass×3 (0→1→2→3), miss (drop 3→2), pass×2 (2→3→4)
    const s = run(l, ['pass', 'pass', 'pass', 'miss', 'pass', 'pass'])
    expect(s.rungIndex).toBe(4)
    expect(s.rungHistory).toEqual([0, 1, 2, 3, 2, 3, 4])
  })

  it('does not append the past-the-end graduation index', () => {
    const l: Ladder = { rungs: [rung(), rung()] }
    const s = run(l, ['pass', 'pass'])   // 0→1, then 1→graduated
    expect(s.graduated).toBe(true)
    expect(s.rungHistory).toEqual([0, 1])   // stops at the last real rung
  })

  it('a stay repeats the rung (records every attempt, not just changes)', () => {
    // Rung 0 needs 3 passes in a row to advance; rung 1 advances on 1.
    const l: Ladder = { rungs: [rung({ advanceTimes: 3, advanceInARow: true }), rung()] }
    const s = run(l, ['pass', 'pass', 'pass'])   // stay, stay, advance 0→1
    expect(s.rungIndex).toBe(1)
    expect(s.rungHistory).toEqual([0, 0, 0, 1])   // rung 1 repeated for the two stays
  })
})

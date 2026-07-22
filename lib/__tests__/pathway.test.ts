import type { Pathway, PathwayState, Transition, Ladder, Rung } from '@/domain'
import { DEFAULT_LADDER } from '@/domain'
import { validatePathway, ladderToPathway } from '@/lib/pathway'
import { stepPathway, initialRouteState, type PathwayEvent } from '@/engine/pathwayEngine'

const NOW = 1_000_000_000_000
let sc = 0
function state(over: Partial<PathwayState> = {}): PathwayState {
  return { id: `s${sc++}`, name: over.name ?? 'S', type: 'typing', direction: 'produce_target', selfRated: false, intervalInit: false, ...over }
}
const terminal = (): PathwayState => ({ id: 'grad', name: 'Graduated', type: 'self_graded', direction: 'produce_target', selfRated: false, intervalInit: false, isTerminal: true })
function tr(from: string, to: string, priority = 100): Transition {
  return { id: `${from}->${to}`, from, to, when: [], priority }
}
function make(states: PathwayState[], transitions: Transition[], start = states[0]!.id): Pathway {
  return { id: 'p', startStateId: start, states, transitions, betweenStateWaitSeconds: 180 }
}

describe('validatePathway', () => {
  it('a minimal start→graduate pathway has no hard errors (only interval warnings)', () => {
    const a = state(), g = terminal()
    const problems = validatePathway(make([a, g], [tr(a.id, g.id)]))
    expect(problems.filter(e => !e.startsWith('Warning:'))).toEqual([])
    expect(problems.every(e => e.startsWith('Warning:'))).toBe(true)
  })

  it('flags a dead-end state', () => {
    const a = state({ name: 'Stuck' }), g = terminal()
    const errs = validatePathway(make([a, g], []))   // a has no outgoing transition
    expect(errs.some(e => /Stuck.*dead end/i.test(e))).toBe(true)
  })

  it('flags a state from which graduation is unreachable (loop with no exit to terminal)', () => {
    const a = state({ name: 'A' }), b = state({ name: 'B' }), g = terminal()
    // A↔B loop, neither reaches the terminal.
    const errs = validatePathway(make([a, b, g], [tr(a.id, b.id), tr(b.id, a.id)]))
    expect(errs.some(e => /can never reach graduation/i.test(e))).toBe(true)
  })

  it('allows a loop as long as graduation stays reachable', () => {
    const a = state({ name: 'A' }), b = state({ name: 'B' }), g = terminal()
    // A→B, B→A (loop), and A→graduate — reachable, so OK.
    const errs = validatePathway(make([a, b, g], [tr(a.id, b.id), tr(b.id, a.id), tr(a.id, g.id)]))
    expect(errs.filter(e => !e.startsWith('Warning:'))).toEqual([])
  })

  it('rejects >1 interval-setter for the same direction', () => {
    const a = state({ type: 'typing', direction: 'produce_target', selfRated: true, intervalInit: true, name: 'A' })
    const b = state({ type: 'typing', direction: 'produce_target', selfRated: true, intervalInit: true, name: 'B' })
    const g = terminal()
    const errs = validatePathway(make([a, b, g], [tr(a.id, b.id), tr(b.id, g.id)]))
    expect(errs.some(e => /More than one state sets the target-direction/i.test(e))).toBe(true)
  })

  it('rejects an interval-setter on an ineligible state (mcq / dictation-target)', () => {
    const a = state({ type: 'mcq', intervalInit: true, name: 'A' }), g = terminal()
    expect(validatePathway(make([a, g], [tr(a.id, g.id)])).some(e => /can't set the interval/i.test(e))).toBe(true)
  })

  it('warns (does not error) on an unreachable state', () => {
    const a = state({ name: 'A' }), orphan = state({ name: 'Orphan' }), g = terminal()
    const errs = validatePathway(make([a, orphan, g], [tr(a.id, g.id), tr(orphan.id, g.id)]))
    expect(errs.filter(e => !e.startsWith('Warning:'))).toEqual([])   // no hard errors
    expect(errs.some(e => /Warning:.*Orphan.*unreachable/i.test(e))).toBe(true)
  })
})

describe('ladderToPathway', () => {
  const ev = (o: PathwayEvent['outcome']): PathwayEvent => ({ outcome: o, errorTypes: [] })

  it('converts to a valid pathway (one state per rung + a terminal)', () => {
    const p = ladderToPathway(DEFAULT_LADDER)
    expect(p.states.filter(s => !s.isTerminal)).toHaveLength(DEFAULT_LADDER.rungs.length)
    expect(p.states.some(s => s.isTerminal)).toBe(true)
    expect(p.startStateId).toBe(DEFAULT_LADDER.rungs[0]!.id)
    // The converted graph is well-formed (no hard errors).
    expect(validatePathway(p).filter(e => !e.startsWith('Warning:'))).toEqual([])
  })

  it('the happy path (pass/good everything) graduates through every state', () => {
    const p = ladderToPathway(DEFAULT_LADDER)
    let s = initialRouteState(p)
    let graduated = false
    // Feed successes until graduation (rung 3 needs 2-in-a-row; feed enough).
    for (let i = 0; i < 40 && !graduated; i++) {
      const st = stepPathway(p, s, ev('good'), NOW)   // good counts as success for both auto & self-rated
      s = st.route
      graduated = st.graduated
    }
    expect(graduated).toBe(true)
    expect(s.stateId).toBe('graduated')
  })

  it('carries over drop-backs and skip-aheads as transitions', () => {
    const rungs: Rung[] = [
      { id: 'a', type: 'typing', direction: 'produce_target', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true,
        dropBacks: [], skipAheads: [{ on: 'pass', times: 1, toRungId: 'c' }] },
      { id: 'b', type: 'typing', direction: 'produce_target', selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true,
        dropBacks: [{ on: 'miss', times: 2, toRungId: 'a' }] },
      { id: 'c', type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true, advanceTimes: 1, advanceInARow: true, dropBacks: [] },
    ]
    const p = ladderToPathway({ rungs })
    expect(p.transitions.some(t => t.from === 'a' && t.to === 'c')).toBe(true)   // skip-ahead
    expect(p.transitions.some(t => t.from === 'b' && t.to === 'a')).toBe(true)   // drop-back
    // drop-back / skip outrank advance in priority (lower number).
    const adv = p.transitions.find(t => t.from === 'a' && t.to === 'b')!
    const skip = p.transitions.find(t => t.from === 'a' && t.to === 'c')!
    expect(skip.priority).toBeLessThan(adv.priority)
  })
})

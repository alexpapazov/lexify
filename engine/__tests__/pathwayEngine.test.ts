import type { Pathway, PathwayState, Transition } from '@/domain'
import { stepPathway, initialRouteState, isSuccess, type PathwayEvent } from '@/engine/pathwayEngine'

const NOW = 1_000_000_000_000

let sc = 0
function state(over: Partial<PathwayState> = {}): PathwayState {
  return { id: `s${sc++}`, name: 'S', type: 'typing', direction: 'produce_target', selfRated: false, intervalInit: false, ...over }
}
const terminal = (id = 'grad'): PathwayState => ({ id, name: 'Graduated', type: 'self_graded', direction: 'produce_target', selfRated: false, intervalInit: false, isTerminal: true })
function tr(from: string, to: string, when: Transition['when'], over: Partial<Transition> = {}): Transition {
  return { id: `${from}->${to}`, from, to, when, priority: 100, ...over }
}
function make(states: PathwayState[], transitions: Transition[], start = states[0]!.id, wait = 180): Pathway {
  return { id: 'p', startStateId: start, states, transitions, betweenStateWaitSeconds: wait }
}
const ev = (outcome: PathwayEvent['outcome'], errorTypes: PathwayEvent['errorTypes'] = []): PathwayEvent => ({ outcome, errorTypes })

describe('isSuccess', () => {
  it('pass/good/easy are success; almost/miss/again/hard are not', () => {
    expect(['pass', 'good', 'easy'].every(isSuccess as (o: string) => boolean)).toBe(true)
    expect(['almost', 'miss', 'again', 'hard'].some(isSuccess as (o: string) => boolean)).toBe(false)
  })
})

describe('stepPathway — basics', () => {
  it('an unconditional edge fires on any outcome and moves the card', () => {
    const a = state(), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [])])
    const r = stepPathway(p, initialRouteState(p), ev('miss'), NOW)
    expect(r.moved).toBe(true)
    expect(r.graduated).toBe(true)         // moved straight into the terminal
    expect(r.route.stateId).toBe(g.id)
  })

  it('stays (no move) when no transition matches, and reshows after the global gap', () => {
    const a = state(), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [{ kind: 'rating', is: 'easy' }])], a.id, 300)
    const r = stepPathway(p, initialRouteState(p), ev('good'), NOW)   // needs easy, got good
    expect(r.moved).toBe(false)
    expect(r.route.stateId).toBe(a.id)
    expect(r.reshowSeconds).toBe(300)
    expect(r.route.consecutiveGood).toBe(1)  // counter still bumped
  })

  it('first matching transition wins by priority', () => {
    const a = state(), b = state(), c = state()
    const p = make(
      [a, b, c, terminal()],
      [
        tr(a.id, c.id, [{ kind: 'correct', is: true }], { priority: 50 }),  // higher priority (lower number)
        tr(a.id, b.id, [{ kind: 'correct', is: true }], { priority: 100 }),
      ],
    )
    expect(stepPathway(p, initialRouteState(p), ev('pass'), NOW).route.stateId).toBe(c.id)
  })
})

describe('stepPathway — counters & routing', () => {
  it('consecutiveGood≥2 fires on Good→Good but NOT on Good→Again→Good', () => {
    const a = state({ selfRated: true }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [{ kind: 'counter', name: 'consecutiveGood', gte: 2 }])])
    // Good, Again, Good — the Again breaks the streak, so it never reaches two in a row.
    let s = initialRouteState(p)
    s = stepPathway(p, s, ev('good'), NOW).route
    s = stepPathway(p, s, ev('again'), NOW).route
    const broken = stepPathway(p, s, ev('good'), NOW)
    expect(broken.moved).toBe(false)
    expect(broken.route.consecutiveGood).toBe(1)
    // Good, Good — two in a row → fires.
    let s2 = stepPathway(p, initialRouteState(p), ev('good'), NOW).route
    expect(stepPathway(p, s2, ev('good'), NOW).moved).toBe(true)
  })

  it('error type routes to a targeted state', () => {
    const a = state(), accent = state({ name: 'Accent Retype' }), g = terminal()
    const p = make([a, accent, g], [
      tr(a.id, accent.id, [{ kind: 'errorType', is: 'accent' }], { priority: 10 }),
      tr(a.id, g.id, [{ kind: 'correct', is: true }], { priority: 100 }),
    ])
    expect(stepPathway(p, initialRouteState(p), ev('miss', ['accent']), NOW).route.stateId).toBe(accent.id)
    expect(stepPathway(p, initialRouteState(p), ev('pass'), NOW).route.stateId).toBe(g.id)
  })

  it('resetCounters zeroes a counter on taking the edge', () => {
    const a = state(), b = state(), g = terminal()
    const p = make([a, b, g], [
      tr(a.id, b.id, [{ kind: 'correct', is: true }], { resetCounters: ['totalAgain'] }),
      tr(b.id, g.id, []),
    ])
    let s = initialRouteState(p)
    s = { ...s, totalAgain: 5 }
    s = stepPathway(p, s, ev('pass'), NOW).route
    expect(s.totalAgain).toBe(0)   // reset on entry + explicit reset
  })
})

describe('stepPathway — ratedCount ("N Goods in a row / in total")', () => {
  const good2InARow = { kind: 'ratedCount', rating: 'good', times: 2, inARow: true } as const

  it('fires on the answer that completes the streak', () => {
    const a = state({ selfRated: true }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [good2InARow])])
    const r1 = stepPathway(p, initialRouteState(p), ev('good'), NOW)
    expect(r1.moved).toBe(false)                                  // 1 of 2
    const r2 = stepPathway(p, r1.route, ev('good'), NOW)
    expect(r2.moved).toBe(true)                                   // 2 in a row → go
  })

  it('an Easy does NOT count toward a Good streak — exact outcome, unlike the success aggregates', () => {
    const a = state({ selfRated: true }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [good2InARow])])
    const r1 = stepPathway(p, initialRouteState(p), ev('good'), NOW)
    const r2 = stepPathway(p, r1.route, ev('easy'), NOW)          // breaks the Good run
    expect(r2.moved).toBe(false)
    const r3 = stepPathway(p, r2.route, ev('good'), NOW)
    expect(r3.moved).toBe(false)                                  // run restarted: 1 of 2
    expect(stepPathway(p, r3.route, ev('good'), NOW).moved).toBe(true)
  })

  it('"in total" survives interruptions; "in a row" does not', () => {
    const mk = (inARow: boolean) => {
      const a = state({ selfRated: true }), g = terminal()
      return make([a, g], [tr(a.id, g.id, [{ kind: 'ratedCount', rating: 'good', times: 2, inARow }])])
    }
    // Good, Again, Good — 2 Goods total but never 2 in a row.
    for (const [inARow, shouldMove] of [[true, false], [false, true]] as const) {
      const p = mk(inARow)
      let route = initialRouteState(p)
      route = stepPathway(p, route, ev('good'), NOW).route
      route = stepPathway(p, route, ev('again'), NOW).route
      expect(stepPathway(p, route, ev('good'), NOW).moved).toBe(shouldMove)
    }
  })

  it('counts auto-checked correct answers via rating: "pass"', () => {
    const a = state(), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [{ kind: 'ratedCount', rating: 'pass', times: 2, inARow: true }])])
    let route = initialRouteState(p)
    route = stepPathway(p, route, ev('pass'), NOW).route
    expect(stepPathway(p, route, ev('pass'), NOW).moved).toBe(true)
  })

  it('tallies reset when a state is entered, like every other counter', () => {
    const a = state({ selfRated: true }), b = state({ selfRated: true }), g = terminal()
    const p = make([a, b, g], [
      tr(a.id, b.id, [{ kind: 'rating', is: 'again' }]),          // any Again hops to b
      tr(b.id, g.id, [good2InARow]),
    ])
    let route = initialRouteState(p)
    route = stepPathway(p, route, ev('good'), NOW).route          // 1 Good tallied in a
    route = stepPathway(p, route, ev('again'), NOW).route         // → b (tallies reset)
    route = stepPathway(p, route, ev('good'), NOW).route          // 1 of 2 in b — a's Good must not carry
    expect(route.stateId).toBe(b.id)
    expect(stepPathway(p, route, ev('good'), NOW).moved).toBe(true)
  })

  it('a route saved before the tallies existed evaluates as zero, not as a crash', () => {
    const a = state({ selfRated: true }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [good2InARow])])
    const legacy = { ...initialRouteState(p) }
    delete (legacy as Record<string, unknown>).outcomeTotals
    delete (legacy as Record<string, unknown>).outcomeStreaks
    const r = stepPathway(p, legacy, ev('good'), NOW)
    expect(r.moved).toBe(false)                                   // 1 of 2, counted from scratch
    expect(stepPathway(p, r.route, ev('good'), NOW).moved).toBe(true)
  })
})

describe('stepPathway — graduation intervals', () => {
  it('leaving an intervalInit state on Easy records that direction; the other defaults to 1 day', () => {
    const a = state({ selfRated: true, intervalInit: true, direction: 'produce_target' }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [{ kind: 'rating', is: 'easy' }])])
    const r = stepPathway(p, initialRouteState(p), ev('easy'), NOW)
    expect(r.graduated).toBe(true)
    expect(r.route.targetInterval!.min).toBeGreaterThan(1)   // Easy → a bonus interval
    expect(r.route.nativeInterval).toEqual({ min: 1, max: 1 })  // never set → 1-day default
  })

  it('a Good departure from an intervalInit state sets a flat 1 day for that direction', () => {
    const a = state({ selfRated: true, intervalInit: true, direction: 'produce_native' }), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [{ kind: 'counter', name: 'totalGood', gte: 1 }])])
    const r = stepPathway(p, initialRouteState(p), ev('good'), NOW)
    expect(r.route.nativeInterval).toEqual({ min: 1, max: 1 })
  })

  it('a terminal/graduated route is inert', () => {
    const a = state(), g = terminal()
    const p = make([a, g], [tr(a.id, g.id, [])])
    const done = stepPathway(p, initialRouteState(p), ev('pass'), NOW).route
    const again = stepPathway(p, done, ev('again'), NOW)
    expect(again.moved).toBe(false)
    expect(again.graduated).toBe(true)
  })
})

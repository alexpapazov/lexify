import { LADDER_PRESETS, PATHWAY_PRESETS } from '../learningPresets'
import { validatePathway } from '../pathway'
import { stepPathway, initialRouteState } from '@/engine/pathwayEngine'
import { initialClimbState, reviewRung } from '@/engine/ladderEngine'
import type { Pathway } from '@/domain'

describe('ladder presets', () => {
  it('offers three, each with a unique id and at least one rung', () => {
    expect(LADDER_PRESETS).toHaveLength(3)
    expect(new Set(LADDER_PRESETS.map(p => p.id)).size).toBe(3)
    for (const p of LADDER_PRESETS) expect(p.build().rungs.length).toBeGreaterThan(0)
  })

  it('every rung id is unique and every drop-back / skip-ahead targets a real rung', () => {
    for (const p of LADDER_PRESETS) {
      const l = p.build()
      const ids = l.rungs.map(r => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const r of l.rungs) {
        for (const d of r.dropBacks) expect(ids).toContain(d.toRungId)
        for (const s of r.skipAheads ?? []) expect(ids).toContain(s.toRungId)
      }
    }
  })

  it('every preset sets both graduation directions', () => {
    for (const p of LADDER_PRESETS) {
      const l = p.build()
      // At least one interval-setting rung, or graduation falls back to a flat 1 day.
      expect(l.rungs.some(r => r.intervalInit)).toBe(true)
    }
  })

  it('each preset can actually be climbed to graduation', () => {
    for (const p of LADDER_PRESETS) {
      const ladder = p.build()
      let s = initialClimbState()
      for (let i = 0; i < 60 && !s.graduated; i++) {
        // Auto-checked rungs record pass/miss; self-rated ones record a rating. Feeding the wrong
        // family reads as a failure and the climb never moves.
        const rung = ladder.rungs[s.rungIndex]
        s = reviewRung(ladder, s, rung?.selfRated ? 'easy' : 'pass', Date.now()).state
      }
      expect(s.graduated).toBe(true)
    }
  })
})

describe('pathway presets', () => {
  it('offers three, each with a unique id', () => {
    expect(PATHWAY_PRESETS).toHaveLength(3)
    expect(new Set(PATHWAY_PRESETS.map(p => p.id)).size).toBe(3)
  })

  it('every preset validates with no errors', () => {
    for (const p of PATHWAY_PRESETS) {
      expect(validatePathway(p.build())).toEqual([])
    }
  })

  it('every transition points at a state that exists', () => {
    for (const p of PATHWAY_PRESETS) {
      const pw = p.build()
      const ids = new Set(pw.states.map(s => s.id))
      for (const t of pw.transitions) {
        expect(ids.has(t.from)).toBe(true)
        expect(ids.has(t.to)).toBe(true)
      }
      expect(ids.has(pw.startStateId)).toBe(true)
    }
  })

  it('transition ids are unique within a pathway', () => {
    for (const p of PATHWAY_PRESETS) {
      const ids = p.build().transitions.map(t => t.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })
})

describe('adaptive (advanced) pathway', () => {
  const build = () => PATHWAY_PRESETS.find(p => p.id === 'adaptive-advanced')!.build()

  /** Walks the pathway, returning the state ids visited (excluding the start). */
  function walk(pw: Pathway, outcomes: ('easy' | 'good' | 'hard' | 'again' | 'pass' | 'miss')[]) {
    let route = initialRouteState(pw)
    const visited: string[] = []
    let now = 0
    for (const o of outcomes) {
      now += 60_000
      const res = stepPathway(pw, route, { outcome: o, errorTypes: [] }, now)
      route = res.route
      visited.push(res.graduated ? 'GRADUATED' : route.stateId)
      if (res.graduated) break
    }
    return visited
  }

  it('the fast route is three questions: MCQ correct → Easy → Easy → graduated', () => {
    expect(walk(build(), ['pass', 'easy', 'easy'])).toEqual(['b', 'c', 'GRADUATED'])
  })

  it('the good route needs two Goods at each setter', () => {
    expect(walk(build(), ['pass', 'good', 'good', 'good', 'good']))
      .toEqual(['b', 'b', 'c', 'c', 'GRADUATED'])
  })

  it('failing the target setter returns to the initial MCQ, not onward', () => {
    expect(walk(build(), ['pass', 'again'])).toEqual(['b', 'a'])
  })

  it('failing the native setter drops to native support, then back to the setter', () => {
    expect(walk(build(), ['pass', 'easy', 'again', 'pass'])).toEqual(['b', 'c', 'd', 'c'])
  })

  it('a wrong initial MCQ repeats the initial MCQ', () => {
    expect(walk(build(), ['miss'])).toEqual(['a'])
  })

  it('both interval-setting stages are marked, one per direction', () => {
    const pw = build()
    const setters = pw.states.filter(s => s.intervalInit)
    expect(setters.map(s => s.id)).toEqual(['b', 'c'])
    expect(setters.map(s => s.direction)).toEqual(['produce_target', 'produce_native'])
  })

  it('the support stages are NOT interval setters', () => {
    const pw = build()
    for (const id of ['a', 'd']) {
      expect(pw.states.find(s => s.id === id)!.intervalInit).toBe(false)
    }
  })
})

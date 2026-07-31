import {
  ladderMinAnswers, pathwayMinAnswers, minAnswersForPipeline, struggleFactor, newCardMs,
  MIN_STRUGGLE, MAX_STRUGGLE,
} from '../pipelineCost'
import { LADDER_PRESETS, PATHWAY_PRESETS } from '../learningPresets'
import { DEFAULT_LADDER } from '@/domain'
import type { Ladder, Pathway } from '@/domain'

const rung = (id: string, over: Partial<Ladder['rungs'][number]> = {}): Ladder['rungs'][number] => ({
  id, type: 'mcq', direction: 'produce_target', selfRated: false, intervalInit: false,
  advanceTimes: 1, advanceInARow: true, dropBacks: [], ...over,
})

describe('ladderMinAnswers', () => {
  it('sums one answer per rung by default', () => {
    expect(ladderMinAnswers({ rungs: [rung('a'), rung('b'), rung('c')] })).toBe(3)
  })

  it('respects a rung that needs several passes', () => {
    expect(ladderMinAnswers({ rungs: [rung('a'), rung('b', { advanceTimes: 2 })] })).toBe(3)
  })

  it('takes the CHEAPEST advance rule, since the rules are OR-ed', () => {
    const l: Ladder = { rungs: [rung('a', {
      advanceRules: [{ times: 2, inARow: true, minRating: 'good' }, { times: 1, inARow: true, minRating: 'easy' }],
    })] }
    expect(ladderMinAnswers(l)).toBe(1)
  })

  it('treats a zero/missing advanceTimes as one answer, never zero', () => {
    expect(ladderMinAnswers({ rungs: [rung('a', { advanceTimes: 0 })] })).toBe(1)
  })

  it('ignores drop-backs — this is the floor, not the expected path', () => {
    const withDropBack: Ladder = { rungs: [rung('a'), rung('b', { dropBacks: [{ on: 'miss', times: 1, toRungId: 'a' }] })] }
    expect(ladderMinAnswers(withDropBack)).toBe(2)
  })

  it('is 0 for an empty ladder', () => {
    expect(ladderMinAnswers({ rungs: [] })).toBe(0)
  })

  it('scores the shipped default ladder', () => {
    // 1 + 1 + 2 + 1 + 1
    expect(ladderMinAnswers(DEFAULT_LADDER)).toBe(6)
  })

  it('ranks the presets: fast < balanced < thorough', () => {
    const by = (id: string) => ladderMinAnswers(LADDER_PRESETS.find(p => p.id === id)!.build())
    expect(by('fast')).toBeLessThan(by('balanced'))
    expect(by('balanced')).toBeLessThan(by('thorough'))
  })
})

describe('pathwayMinAnswers', () => {
  const P = (states: Pathway['states'], transitions: Pathway['transitions'], start = 's1'): Pathway =>
    ({ id: 'p', startStateId: start, states, transitions, betweenStateWaitSeconds: 60 })
  const st = (id: string, over: Partial<Pathway['states'][number]> = {}): Pathway['states'][number] => ({
    id, name: id, type: 'mcq', direction: 'produce_target', selfRated: false, intervalInit: false, ...over,
  })
  const grad = st('g', { isTerminal: true })

  it('counts one answer per state on the shortest route', () => {
    const p = P([st('s1'), st('s2'), grad], [
      { id: 't1', from: 's1', to: 's2', when: [], priority: 1 },
      { id: 't2', from: 's2', to: 'g',  when: [], priority: 1 },
    ])
    expect(pathwayMinAnswers(p)).toBe(2)
  })

  it('takes the SHORTEST route when a shortcut exists', () => {
    const p = P([st('s1'), st('s2'), st('s3'), grad], [
      { id: 'a', from: 's1', to: 's2', when: [], priority: 1 },
      { id: 'b', from: 's2', to: 's3', when: [], priority: 1 },
      { id: 'c', from: 's3', to: 'g',  when: [], priority: 1 },
      { id: 'd', from: 's1', to: 'g',  when: [], priority: 2 },   // shortcut
    ])
    expect(pathwayMinAnswers(p)).toBe(1)
  })

  it('is not fooled by a cycle', () => {
    const p = P([st('s1'), st('s2'), grad], [
      { id: 'a', from: 's1', to: 's2', when: [], priority: 1 },
      { id: 'b', from: 's2', to: 's1', when: [], priority: 1 },   // loops back
      { id: 'c', from: 's2', to: 'g',  when: [], priority: 2 },
    ])
    expect(pathwayMinAnswers(p)).toBe(2)
  })

  it('returns 0 when graduation is unreachable', () => {
    const p = P([st('s1'), st('s2'), grad], [{ id: 'a', from: 's1', to: 's2', when: [], priority: 1 }])
    expect(pathwayMinAnswers(p)).toBe(0)
  })

  it('returns 0 when there is no terminal state at all', () => {
    expect(pathwayMinAnswers(P([st('s1')], []))).toBe(0)
  })

  it('scores the adaptive preset as its documented three-question fast route', () => {
    const adaptive = PATHWAY_PRESETS.find(p => p.id === 'adaptive-advanced')!.build()
    expect(pathwayMinAnswers(adaptive)).toBe(3)
  })

  it('every pathway preset is reachable', () => {
    for (const p of PATHWAY_PRESETS) expect(pathwayMinAnswers(p.build())).toBeGreaterThan(0)
  })
})

describe('minAnswersForPipeline', () => {
  const ladder: Ladder = { rungs: [rung('a'), rung('b')] }
  const pathway = PATHWAY_PRESETS.find(p => p.id === 'adaptive-advanced')!.build()

  it('reads the pathway in pathway mode and the ladder in ladder mode', () => {
    expect(minAnswersForPipeline('pathway', ladder, pathway)).toBe(3)
    expect(minAnswersForPipeline('ladder', ladder, pathway)).toBe(2)
  })

  it('falls back to the ladder when pathway mode has no pathway', () => {
    expect(minAnswersForPipeline('pathway', ladder, null)).toBe(2)
  })

  it('is 0 when nothing is readable', () => {
    expect(minAnswersForPipeline('ladder', null, null)).toBe(0)
  })
})

describe('struggleFactor', () => {
  it('is 1 when every card graduates in the minimum number of answers', () => {
    expect(struggleFactor([{ answers: 60, graduations: 10, minAnswers: 6 }])).toBe(1)
  })

  it('reports the real multiple when cards take longer', () => {
    expect(struggleFactor([{ answers: 120, graduations: 10, minAnswers: 6 }])).toBe(2)
  })

  it('pools across languages rather than per language', () => {
    // A short pipeline done cleanly + a long one done sloppily → one blended factor.
    const f = struggleFactor([
      { answers: 20, graduations: 10, minAnswers: 2 },   // exactly minimum
      { answers: 120, graduations: 10, minAnswers: 6 },  // twice minimum
    ])
    expect(f).toBeGreaterThan(1)
    expect(f).toBeLessThan(2)
  })

  it('never drops below 1 — you cannot beat the structural minimum', () => {
    expect(struggleFactor([{ answers: 10, graduations: 10, minAnswers: 6 }])).toBe(MIN_STRUGGLE)
  })

  it('is capped so a thin unlucky window cannot quote an absurd figure', () => {
    expect(struggleFactor([{ answers: 10_000, graduations: 1, minAnswers: 2 }])).toBe(MAX_STRUGGLE)
  })

  it('falls back to 1 with no usable data', () => {
    expect(struggleFactor([])).toBe(MIN_STRUGGLE)
    expect(struggleFactor([{ answers: 0, graduations: 0, minAnswers: 6 }])).toBe(MIN_STRUGGLE)
    expect(struggleFactor([{ answers: 50, graduations: 5, minAnswers: 0 }])).toBe(MIN_STRUGGLE)
  })
})

describe('newCardMs', () => {
  it('multiplies structure by struggle by pace', () => {
    expect(newCardMs({ minAnswers: 6, struggle: 1.5, msPerAnswer: 10_000 })).toBe(90_000)
  })

  it('reacts immediately to a shorter pipeline — the whole point', () => {
    const long  = newCardMs({ minAnswers: 8, struggle: 1.5, msPerAnswer: 10_000 })
    const short = newCardMs({ minAnswers: 2, struggle: 1.5, msPerAnswer: 10_000 })
    expect(short).toBeLessThan(long)
    expect(short / long).toBeCloseTo(2 / 8, 5)
  })

  it('reacts to a language getting faster', () => {
    const slow = newCardMs({ minAnswers: 6, struggle: 1.5, msPerAnswer: 20_000 })
    const fast = newCardMs({ minAnswers: 6, struggle: 1.5, msPerAnswer: 5_000 })
    expect(fast).toBeLessThan(slow)
  })

  it('never lets a sub-1 struggle shrink the estimate below the structural floor', () => {
    expect(newCardMs({ minAnswers: 6, struggle: 0.2, msPerAnswer: 10_000 })).toBe(60_000)
  })

  it('uses the historical per-word figure when the pipeline is unreadable', () => {
    expect(newCardMs({ minAnswers: 0, struggle: 1.5, msPerAnswer: 10_000, fallbackPerWordMs: 42_000 })).toBe(42_000)
  })

  it('still returns something sensible with neither structure nor history', () => {
    expect(newCardMs({ minAnswers: 0, struggle: 1, msPerAnswer: 0 })).toBeGreaterThan(0)
  })
})

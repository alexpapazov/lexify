import type { Ladder, Rung } from '@/domain'
import { DEFAULT_LADDER } from '@/domain'
import { validateLadder, newRung, canInitInterval, resolveEffectiveLadder } from '@/lib/ladder'

const rung = (over: Partial<Rung>): Rung => ({
  id: Math.random().toString(36).slice(2), type: 'typing', direction: 'produce_target',
  selfRated: false, intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [], ...over,
})

describe('validateLadder', () => {
  it('the built-in default ladder is valid', () => {
    expect(validateLadder(DEFAULT_LADDER)).toEqual([])
  })

  it('an empty ladder is invalid', () => {
    expect(validateLadder({ rungs: [] })[0]).toMatch(/at least one rung/i)
  })

  it('dictation may produce either direction (hear the target, type target OR its translation)', () => {
    const l: Ladder = { rungs: [rung({ type: 'dictation', direction: 'produce_native' })] }
    expect(validateLadder(l).some(e => /dictation/i.test(e))).toBe(false)
  })

  it('interval-init only allowed on typing/self_graded', () => {
    const l: Ladder = { rungs: [rung({ type: 'mcq', intervalInit: true })] }
    expect(validateLadder(l).some(e => /only typing or self-graded/i.test(e))).toBe(true)
  })

  it('interval-init must be exactly one per direction, or none', () => {
    // Only one direction covered → invalid.
    const oneSide: Ladder = { rungs: [rung({ type: 'typing', direction: 'produce_target', intervalInit: true })] }
    expect(validateLadder(oneSide).some(e => /one for each direction/i.test(e))).toBe(true)

    // One per direction → valid.
    const both: Ladder = { rungs: [
      rung({ type: 'typing', direction: 'produce_target', intervalInit: true }),
      rung({ type: 'self_graded', direction: 'produce_native', selfRated: true, intervalInit: true }),
    ] }
    expect(validateLadder(both)).toEqual([])

    // None → valid.
    const none: Ladder = { rungs: [rung({})] }
    expect(validateLadder(none)).toEqual([])
  })
})

describe('newRung', () => {
  it('self_graded is self-rated; dictation is target-only; mcq gets a distractor source', () => {
    expect(newRung('self_graded').selfRated).toBe(true)
    expect(newRung('dictation').direction).toBe('produce_target')
    expect(newRung('mcq').distractorSource).toBe('deck')
    expect(newRung('typing').strictness).toBeDefined()
  })
})

describe('canInitInterval', () => {
  it('typing and self_graded only', () => {
    expect(canInitInterval('typing')).toBe(true)
    expect(canInitInterval('self_graded')).toBe(true)
    expect(canInitInterval('mcq')).toBe(false)
    expect(canInitInterval('dictation')).toBe(false)
  })
})

describe('resolveEffectiveLadder', () => {
  it('prefers the pair ladder, then default, then built-in', () => {
    const pair: Ladder = { rungs: [rung({ id: 'p' })] }
    const def: Ladder = { rungs: [rung({ id: 'd' })] }
    expect(resolveEffectiveLadder(pair, def).rungs[0]!.id).toBe('p')
    expect(resolveEffectiveLadder(null, def).rungs[0]!.id).toBe('d')
    expect(resolveEffectiveLadder(null, null)).toBe(DEFAULT_LADDER)
    expect(resolveEffectiveLadder({ rungs: [] }, null)).toBe(DEFAULT_LADDER)
  })
})

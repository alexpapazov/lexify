import type { Rung } from '@/domain'
import { rungUI, producesNative, mcqOutcome, typedOutcome, pickIntervalDay } from '@/lib/ladderSession'

const rung = (over: Partial<Rung>): Rung => ({
  id: 'x', type: 'typing', direction: 'produce_target', selfRated: false,
  intervalInit: false, advanceTimes: 1, advanceInARow: true, dropBacks: [], ...over,
})

describe('rungUI', () => {
  it('maps each rung type to a study screen', () => {
    expect(rungUI(rung({ type: 'mcq' }))).toBe('mcq')
    expect(rungUI(rung({ type: 'typing' }))).toBe('typing')
    expect(rungUI(rung({ type: 'self_graded' }))).toBe('flashcard')
    expect(rungUI(rung({ type: 'dictation' }))).toBe('dictation')
  })
})

describe('producesNative', () => {
  it('true only for produce_native rungs', () => {
    expect(producesNative(rung({ direction: 'produce_native' }))).toBe(true)
    expect(producesNative(rung({ direction: 'produce_target' }))).toBe(false)
  })
})

describe('mcqOutcome', () => {
  it('auto-checked: pass / miss', () => {
    expect(mcqOutcome(true, false)).toBe('pass')
    expect(mcqOutcome(false, false)).toBe('miss')
  })
  it('self-rated: correct → rating, wrong → again', () => {
    expect(mcqOutcome(true, true, 'easy')).toBe('easy')
    expect(mcqOutcome(false, true, 'easy')).toBe('again')
  })
})

describe('typedOutcome', () => {
  it('auto-checked passes the status straight through', () => {
    expect(typedOutcome('almost', false)).toBe('almost')
    expect(typedOutcome('miss', false)).toBe('miss')
  })
  it('self-rated: pass → rating, anything else → again', () => {
    expect(typedOutcome('pass', true, 'good')).toBe('good')
    expect(typedOutcome('almost', true, 'good')).toBe('again')
  })
})

describe('pickIntervalDay', () => {
  it('chooses the least-busy day in the range (ties keep the earliest)', () => {
    expect(pickIntervalDay({ min: 3, max: 4 }, new Map([[3, 10], [4, 2]]))).toBe(4)
    expect(pickIntervalDay({ min: 2, max: 3 }, new Map([[2, 5], [3, 5]]))).toBe(2)  // tie → earliest
    expect(pickIntervalDay({ min: 1, max: 1 }, new Map())).toBe(1)
  })
})

import type { Rung } from '@/domain'
import { rungUI, producesNative, mcqOutcome, typedOutcome, pickIntervalDay, reshowDelayMs, pickNextCard, type QueueItem } from '@/lib/ladderSession'

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

describe('reshowDelayMs', () => {
  it('Again ~1 min, Hard ~5 min, Good ~10 min, advanced 3 min (between-rung wait)', () => {
    expect(reshowDelayMs('soon')).toBe(60_000)
    expect(reshowDelayMs('short')).toBe(300_000)
    expect(reshowDelayMs('medium')).toBe(600_000)
    expect(reshowDelayMs('advanced')).toBe(180_000)
  })
})

describe('pickNextCard', () => {
  const NOW = 1_000_000
  const free = (id: string): QueueItem => ({ cardId: id, readyAt: 0, ratedAt: 0 })
  const timer = (id: string, readyAt: number, ratedAt: number): QueueItem => ({ cardId: id, readyAt, ratedAt })

  it('an elapsed timer must go next, even before a free card', () => {
    const q = [free('a'), timer('good', NOW - 1, NOW - 600_000)]  // 'good' is overdue
    expect(pickNextCard(q, NOW)?.cardId).toBe('good')
  })

  it('most-overdue timer goes first', () => {
    const q = [timer('hard', NOW - 100, NOW - 300_000), timer('again', NOW - 5000, NOW - 60_000)]
    expect(pickNextCard(q, NOW)?.cardId).toBe('again')  // earliest readyAt = most overdue
  })

  it('fills time with a free card while a timer is still counting down', () => {
    const q = [timer('good', NOW + 500_000, NOW), free('b')]  // 'good' not due yet
    expect(pickNextCard(q, NOW)?.cardId).toBe('b')
  })

  it('when all are waiting timers, picks the one closest to its target', () => {
    const q = [timer('a', NOW + 400_000, NOW - 200_000), timer('b', NOW + 100_000, NOW - 500_000)]
    expect(pickNextCard(q, NOW)?.cardId).toBe('b')  // b is ~83% elapsed vs a ~33%
  })

  it('avoids immediately repeating the just-shown card when there is an alternative', () => {
    const q = [free('cur'), free('other')]
    expect(pickNextCard(q, NOW, 'cur')?.cardId).toBe('other')
  })
})

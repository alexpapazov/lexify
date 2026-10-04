import type { CardState } from '@/domain'
import { initialCardState } from '@/engine/pipeline'
import { deckDuePools } from '@/lib/todayPools'

const TZ = 'UTC'
const TODAY = '2026-10-04'
const PAST = '2026-10-01T00:00:00.000Z'
const FUTURE = '2026-10-20T00:00:00.000Z'

function state(cardId: string, over: Partial<CardState>): CardState {
  return { ...initialCardState('u1', cardId, 'p1'), ...over }
}

function pools(states: CardState[], tracks?: { typed: boolean; recall: boolean; reverse: boolean; smart: boolean }, threshold = 20) {
  const forwardMap = new Map(states.filter(s => s.reviewDirection !== 'reverse').map(s => [s.cardId, s]))
  return deckDuePools({ states, forwardMap, tracks, smartThresholdDays: threshold, tz: TZ, today: TODAY })
}

describe('deckDuePools — the dashboard/Today split of due cards into session pools', () => {
  it('splits typed, self-graded (smart lane past the threshold), and reverse into their pools', () => {
    const smartTracks = { typed: false, recall: true, reverse: true, smart: true }
    const states = [
      // Smart lane, short interval → presented typed.
      state('a', { graduated: true, smartDueAt: PAST, smartIntervalDays: 3 }),
      // Smart lane, past the smart-typing threshold → presented self-graded.
      state('b', { graduated: true, smartDueAt: PAST, smartIntervalDays: 90 }),
      // Reverse row with a graduated forward counterpart.
      state('c', { graduated: true }),
      state('c', { graduated: true, reviewDirection: 'reverse', recallDueAt: PAST }),
    ]
    const p = pools(states, smartTracks)
    expect(p.typing.map(s => s.cardId)).toEqual(['a'])
    expect(p.sgForward.map(s => s.cardId)).toEqual(['b'])
    expect(p.reverse.map(s => s.cardId)).toEqual(['c'])
  })

  it('on the plain typed lane a due production card presents typed regardless of interval', () => {
    const p = pools([state('a', { graduated: true, typedDueAt: PAST, typedIntervalDays: 90 })])
    expect(p.typing.map(s => s.cardId)).toEqual(['a'])
    expect(p.sgForward).toEqual([])
  })

  it('not-due, non-graduated, and dormant rows stay out; reverse needs a graduated forward row', () => {
    const states = [
      state('future', { graduated: true, typedDueAt: FUTURE }),
      state('learning', { graduated: false, dueAt: PAST }),
      state('dormant', { graduated: true, typedDueAt: PAST, dormant: true }),
      // Reverse due, but its forward row was booted back to the ladder.
      state('booted', { graduated: false }),
      state('booted', { graduated: true, reviewDirection: 'reverse', recallDueAt: PAST }),
    ]
    const p = pools(states)
    expect(p.typing).toEqual([])
    expect(p.sgForward).toEqual([])
    expect(p.reverse).toEqual([])
  })

  it('recall-only due forward rows present self-graded, and reverse dormancy is per-direction', () => {
    const states = [
      // Production not due, but the forward recall track is.
      state('recall', { graduated: true, typedDueAt: FUTURE, recallDueAt: PAST }),
      // Forward row dormant pauses production — the reverse row still reviews.
      state('revOnly', { graduated: true, typedDueAt: PAST, dormant: true }),
      state('revOnly', { graduated: true, reviewDirection: 'reverse', recallDueAt: PAST }),
    ]
    const p = pools(states)
    expect(p.sgForward.map(s => s.cardId)).toEqual(['recall'])
    expect(p.typing).toEqual([])
    expect(p.reverse.map(s => s.cardId)).toEqual(['revOnly'])
  })
})

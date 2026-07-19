import { groupDueSessions, type RawDueEvent } from '@/lib/dueNowLog'

const ev = (cardId: string, at: number, rating = 'good', over: Partial<RawDueEvent> = {}): RawDueEvent =>
  ({ cardId, rating, at, ms: 3000, direction: 'forward', source: 'es', target: 'en', ...over })

const MIN = 60_000

describe('groupDueSessions', () => {
  it('splits on a > 45-minute gap and keeps close reviews together', () => {
    const s = groupDueSessions([
      ev('a', 0), ev('b', 5 * MIN), ev('c', 60 * MIN), ev('d', 62 * MIN),
    ])
    expect(s).toHaveLength(2)
    // newest session first
    expect(s[0]!.cardCount).toBe(2)   // c, d
    expect(s[1]!.cardCount).toBe(2)   // a, b
  })

  it('tallies reviews, lapses, and active time; marks a card lapsed when its last review is again', () => {
    const s = groupDueSessions([
      ev('a', 0, 'again'), ev('a', 2 * MIN, 'good'),   // a recovered → not lapsed
      ev('b', 3 * MIN, 'good'), ev('b', 4 * MIN, 'again'), // b ended on again → lapsed
    ])
    expect(s).toHaveLength(1)
    const sess = s[0]!
    expect(sess.reviewCount).toBe(4)
    expect(sess.againCount).toBe(2)
    expect(sess.activeMs).toBe(4 * 3000)
    const byId = new Map(sess.cards.map(c => [c.cardId, c]))
    expect(byId.get('a')!.lapsed).toBe(false)
    expect(byId.get('b')!.lapsed).toBe(true)
  })

  it('returns nothing for no events', () => {
    expect(groupDueSessions([])).toEqual([])
  })
})

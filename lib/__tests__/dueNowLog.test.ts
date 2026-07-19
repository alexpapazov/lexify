import { groupDueDays, type RawDueEvent } from '@/lib/dueNowLog'

const MIN = 60_000
const ev = (cardId: string, at: number, day: string, rating = 'good', over: Partial<RawDueEvent> = {}): RawDueEvent =>
  ({ cardId, rating, at, ms: 3000, direction: 'forward', source: 'es', target: 'en', day, ...over })

describe('groupDueDays', () => {
  it('puts an entire local day into one session regardless of time gaps', () => {
    const s = groupDueDays([
      ev('a', 0, '2026-07-01'), ev('b', 6 * 60 * MIN, '2026-07-01'),   // 6h apart, same day → one session
      ev('c', 30 * 60 * MIN, '2026-07-02'),                             // next day → separate
    ])
    expect(s).toHaveLength(2)
    expect(s[0]!.day).toBe('2026-07-02')   // newest first
    expect(s[1]!.day).toBe('2026-07-01')
    expect(s[1]!.cardCount).toBe(2)
  })

  it('tallies reviews, lapses, active time; marks lapsed when the last review is again', () => {
    const s = groupDueDays([
      ev('a', 0, 'd1', 'again'), ev('a', 2 * MIN, 'd1', 'good'),   // recovered → not lapsed
      ev('b', 3 * MIN, 'd1', 'good'), ev('b', 4 * MIN, 'd1', 'again'), // ended again → lapsed
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
    expect(groupDueDays([])).toEqual([])
  })
})

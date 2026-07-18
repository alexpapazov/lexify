import { reconstructEvents, type ClimbRecord } from '@/lib/ladderReconstruct'
import { groupSessions } from '@/lib/ladderLog'

const rec = (over: Partial<ClimbRecord>): ClimbRecord => ({
  cardId: 'c1', front: 'hola', source: 'es', target: 'en', rungHistory: [0, 1, 2, 3, 4, 5, 6],
  graduated: true, updatedAtMs: new Date('2026-07-18T05:30:00Z').getTime(), ...over,
})

describe('reconstructEvents', () => {
  it('emits a graduation event at the real time with the top rung', () => {
    const events = reconstructEvents([rec({})])
    const grad = events.filter(e => e.graduated)
    expect(grad).toHaveLength(1)
    expect(grad[0]!.toRung).toBe(grad[0]!.rungCount)      // graduated → top lane
    expect(grad[0]!.createdAt).toBe('2026-07-18T05:30:00.000Z')
    for (const e of events) expect(e.outcome).toBeNull()   // no rating colours
  })

  it('clusters same-pair graduations within the gap and splits far-apart ones', () => {
    const near = rec({ cardId: 'a', updatedAtMs: new Date('2026-07-18T05:00:00Z').getTime() })
    const near2 = rec({ cardId: 'b', updatedAtMs: new Date('2026-07-18T05:05:00Z').getTime() })
    const far = rec({ cardId: 'c', updatedAtMs: new Date('2026-07-18T09:00:00Z').getTime() })
    const sessions = groupSessions(reconstructEvents([near, near2, far]))
    expect(sessions).toHaveLength(2)
    const bySize = sessions.map(s => s.cardCount).sort()
    expect(bySize).toEqual([1, 2])
  })

  it('includes unfinished cards in the cluster but without a graduation event', () => {
    const grad = rec({ cardId: 'g', updatedAtMs: new Date('2026-07-18T05:00:00Z').getTime() })
    const glitched = rec({ cardId: 'x', graduated: false, rungHistory: [0, 1, 2, 2, 3], updatedAtMs: new Date('2026-07-18T05:03:00Z').getTime() })
    const sessions = groupSessions(reconstructEvents([grad, glitched]))
    expect(sessions).toHaveLength(1)
    expect(sessions[0]!.cardCount).toBe(2)
    expect(sessions[0]!.graduatedCount).toBe(1)   // only the graduated one graduates
    const x = sessions[0]!.cards.find(c => c.cardId === 'x')!
    expect(x.graduated).toBe(false)
    expect(x.maxRung).toBe(3)                       // climbed to rung 3, no graduation
  })

  it('ignores climbs with no meaningful history', () => {
    expect(reconstructEvents([rec({ rungHistory: [] })])).toHaveLength(0)
  })
})

import { groupSessions, cardLevelAt } from '@/lib/ladderLog'
import type { LadderEvent } from '@/lib/data/ladderEvents'

const ev = (over: Partial<LadderEvent>): LadderEvent => ({
  id: Math.random().toString(36).slice(2), sessionId: 's1', cardId: 'c1', deckId: 'd1', label: 'hola',
  sourceLanguage: 'es', targetLanguage: 'en', fromRung: 0, toRung: 1, rungCount: 5, rungType: 'mcq',
  outcome: 'pass', advanced: true, graduated: false, durationMs: 2000, createdAt: '2026-07-01T00:00:00Z', ...over,
})

describe('groupSessions', () => {
  it('groups by session and computes per-session + per-card stats', () => {
    const events: LadderEvent[] = [
      ev({ sessionId: 's1', cardId: 'a', fromRung: 0, toRung: 1, durationMs: 1000, createdAt: '2026-07-01T00:00:00Z' }),
      ev({ sessionId: 's1', cardId: 'a', fromRung: 1, toRung: 2, durationMs: 3000, createdAt: '2026-07-01T00:01:00Z' }),
      ev({ sessionId: 's1', cardId: 'b', fromRung: 0, toRung: 0, durationMs: 500, advanced: false, outcome: 'miss', createdAt: '2026-07-01T00:00:30Z' }),
      ev({ sessionId: 's2', cardId: 'a', fromRung: 4, toRung: 5, graduated: true, durationMs: 2000, createdAt: '2026-07-02T00:00:00Z' }),
    ]
    const sessions = groupSessions(events)
    expect(sessions.map(s => s.sessionId)).toEqual(['s2', 's1']) // most recent first
    const s1 = sessions.find(s => s.sessionId === 's1')!
    expect(s1.cardCount).toBe(2)
    expect(s1.attempts).toBe(3)
    expect(s1.activeMs).toBe(4500)
    expect(s1.wallMs).toBe(60_000)
    const cardA = s1.cards.find(c => c.cardId === 'a')!
    expect(cardA.attempts).toBe(2)
    expect(cardA.activeMs).toBe(4000)
    expect(cardA.maxRung).toBe(2)
    const s2 = sessions.find(s => s.sessionId === 's2')!
    expect(s2.graduatedCount).toBe(1)
  })
})

describe('cardLevelAt', () => {
  const events = [
    ev({ cardId: 'a', fromRung: 0, toRung: 1, createdAt: '2026-07-01T00:00:00Z' }),
    ev({ cardId: 'a', fromRung: 1, toRung: 3, createdAt: '2026-07-01T00:05:00Z' }),
    ev({ cardId: 'a', fromRung: 3, toRung: 5, graduated: true, createdAt: '2026-07-01T00:10:00Z' }),
  ]
  const at = (iso: string) => cardLevelAt(events, new Date(iso).getTime())
  it('sits at the first fromRung before any attempt', () => {
    expect(at('2026-06-30T23:00:00Z')).toBe(0)
  })
  it('follows the toRung of the latest attempt at or before t', () => {
    expect(at('2026-07-01T00:00:00Z')).toBe(1)
    expect(at('2026-07-01T00:06:00Z')).toBe(3)
    expect(at('2026-07-01T00:59:00Z')).toBe(5) // graduated → top
  })
})

import type { Card, CardState } from '@/domain'
import type { CardStateRepository, ReviewEventRepository, CreateReviewEventInput } from '@/lib/data/interfaces'
import { initialCardState } from '@/engine/pipeline'
import { buildExpressPool, creditExpressMatch } from '@/lib/expressReview'

const TZ = 'UTC'
const TODAY = '2026-09-01'
const NOW = new Date('2026-09-01T12:00:00.000Z')

function card(id: string, front: string, back: string, source = 'es'): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: source, targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null,
  }
}

function state(cardId: string, over: Partial<CardState>): CardState {
  return { ...initialCardState('u1', cardId, 'p1'), ...over }
}

/** A graduated forward row + a due reverse row for one card. */
function duePair(cardId: string, over: Partial<CardState> = {}): CardState[] {
  return [
    state(cardId, { graduated: true }),
    state(cardId, {
      graduated: true, reviewDirection: 'reverse',
      recallDueAt: '2026-08-30T00:00:00.000Z', recallIntervalDays: 10,
      lastReviewedAt: '2026-08-20T00:00:00.000Z',
      difficulty: 5, stability: 10, reps: 3,
      ...over,
    }),
  ]
}

const poolOpts = { source: null, target: null, tracksByPair: new Map(), tz: TZ, today: TODAY }

describe('buildExpressPool', () => {
  it('serves due reverse rows and nothing else', () => {
    const cards = [card('a', 'perro', 'dog'), card('b', 'gato', 'cat'), card('c', 'pez', 'fish')]
    const states = [
      ...duePair('a'),
      // b: reverse row not due yet
      ...duePair('b').map(s => s.reviewDirection === 'reverse' ? { ...s, recallDueAt: '2026-09-20T00:00:00.000Z' } : s),
      // c: forward row due, but forward rows are not express material
      state('c', { graduated: true, dueAt: '2026-08-30T00:00:00.000Z' }),
    ]
    const { pool } = buildExpressPool(cards, states, poolOpts)
    expect(pool.map(p => p.card.id)).toEqual(['a'])
  })

  it('excludes relearning rows, dormant rows, and reverse rows without a graduated forward row', () => {
    const cards = [card('a', 'uno', '1'), card('b', 'dos', '2'), card('c', 'tres', '3')]
    const states = [
      ...duePair('a').map(s => s.reviewDirection === 'reverse' ? { ...s, relearning: true } : s),
      ...duePair('b').map(s => s.reviewDirection === 'reverse' ? { ...s, dormant: true } : s),
      // c: forward row exists but is NOT graduated (booted back to the ladder)
      state('c', { graduated: false }),
      state('c', { graduated: true, reviewDirection: 'reverse', recallDueAt: '2026-08-30T00:00:00.000Z' }),
    ]
    const { pool } = buildExpressPool(cards, states, poolOpts)
    expect(pool).toEqual([])
  })

  it('scopes to a language pair when asked', () => {
    const cards = [card('a', 'perro', 'dog', 'es'), card('b', 'σκύλος', 'dog (el)', 'el')]
    const states = [...duePair('a'), ...duePair('b')]
    const { pool } = buildExpressPool(cards, states, { ...poolOpts, source: 'el', target: 'en' })
    expect(pool.map(p => p.card.id)).toEqual(['b'])
  })

  it('skips cards whose tiles would be ambiguous (duplicate fronts or backs)', () => {
    const cards = [
      card('a', 'el cerdo', 'pig'), card('b', 'el chancho', 'pig'),   // same gloss — coin-flip tiles
      card('c', 'la mesa', 'table'),
    ]
    const states = [...duePair('a'), ...duePair('b'), ...duePair('c')]
    const { pool, skippedAmbiguous } = buildExpressPool(cards, states, poolOpts)
    expect(pool.map(p => p.card.id)).toEqual(['c'])
    expect(skippedAmbiguous).toBe(2)
  })
})

describe('creditExpressMatch', () => {
  function repos() {
    const upserts: CardState[] = []
    const events: CreateReviewEventInput[] = []
    const stateRepo = {
      upsert: async (s: CardState) => { upserts.push(s); return s },
      countDueByDateRange: async () => new Map<string, number>(),
    } as unknown as CardStateRepository
    const eventRepo = {
      create: async (e: CreateReviewEventInput) => { events.push(e); return { id: 'ev1', ...e } },
    } as unknown as ReviewEventRepository
    return { upserts, events, stateRepo, eventRepo }
  }

  const creditOpts = (r: ReturnType<typeof repos>, c: Card, s: CardState) => ({
    userId: 'u1', card: c, state: s, now: NOW, tz: TZ, turnoverHour: 0,
    retMap: new Map<string, number>(), calMap: new Map<string, number>(),
    stateRepo: r.stateRepo, eventRepo: r.eventRepo,
  })

  it('schedules the reverse row forward like a self-graded Good', async () => {
    const r = repos()
    const c = card('a', 'perro', 'dog')
    const s = duePair('a')[1]!
    const next = await creditExpressMatch(creditOpts(r, c, s))
    expect(r.upserts).toHaveLength(1)
    expect(next.lastRating).toBe('good')
    expect(next.reps).toBe(s.reps + 1)
    expect(next.relearningStep).toBe(0)
    expect(next.recallIntervalDays).toBeGreaterThan(0)
    // The new due date is in the future, and dueAt mirrors it (reverse-row convention).
    expect(new Date(next.recallDueAt!).getTime()).toBeGreaterThan(NOW.getTime())
    expect(next.dueAt).toBe(next.recallDueAt)
    expect(next.lastReviewedAt).toBe(NOW.toISOString())
  })

  it('logs a reverse recognition review event so analytics see it', async () => {
    const r = repos()
    const c = card('a', 'perro', 'dog')
    const next = await creditExpressMatch(creditOpts(r, c, duePair('a')[1]!))
    expect(next.graduated).toBe(true)
    expect(r.events).toHaveLength(1)
    const e = r.events[0]!
    expect(e.mode).toBe('recognition')
    expect(e.reviewDirection).toBe('reverse')
    expect(e.rating).toBe('good')
    expect(e.wasCorrect).toBe(true)
    expect(e.wasTyped).toBe(false)
    expect(e.reviewMode).toBe('due')
  })

  it('a lost event write never fails the credit', async () => {
    const r = repos()
    ;(r.eventRepo as { create: unknown }).create = async () => { throw new Error('offline blip') }
    const next = await creditExpressMatch(creditOpts(r, card('a', 'perro', 'dog'), duePair('a')[1]!))
    expect(r.upserts).toHaveLength(1)
    expect(next.lastRating).toBe('good')
  })

  it('seeds FSRS lazily for a pre-FSRS reverse row (null difficulty/stability)', async () => {
    const r = repos()
    const s = duePair('a')[1]!
    const legacy = { ...s, difficulty: null, stability: null }
    const next = await creditExpressMatch(creditOpts(r, card('a', 'perro', 'dog'), legacy))
    expect(next.difficulty).not.toBeNull()
    expect(next.stability).not.toBeNull()
  })
})

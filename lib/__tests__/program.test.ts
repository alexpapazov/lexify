import { boostRow, creditRow, relearnReview, type ProgramDeps } from '../program'
import { buildProgramBatches, nextMatchingChunk, type ProgramWord } from '../programPool'
import { initialCardState } from '../../engine/pipeline'
import type { Card, CardState } from '@/domain'
import type { EnabledTracks } from '../sessionLimits'

const NOW = new Date('2026-11-20T12:00:00.000Z')
const iso = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

function card(id: string, front = id, back = `${id}-gloss`): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null, pos: 'noun', lemma: front,
  }
}

function grad(cardId: string, over: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u1', cardId, 'p'), graduated: true, difficulty: 5, stability: 20,
    smartIntervalDays: 20, smartDueAt: iso(-1), intervalDays: 20, dueAt: iso(-1),
    lastReviewedAt: iso(-21), reps: 5, ...over }
}

const deps: ProgramDeps = {
  userId: 'u1', src: 'fr', tgt: 'en', now: NOW,
  tracks: { typed: false, smart: true, recall: false, reverse: true } as EnabledTracks,
  retMap: new Map(), calMap: new Map(),
}

describe('boostRow — the intermediate push', () => {
  it('moves the interval toward the full Good interval by strength; memory state untouched', () => {
    const state = grad('c1')
    const full  = boostRow(state, 'production', 1, deps)
    const part  = boostRow(state, 'production', 0.4, deps)
    expect(full.intervalDays).toBeGreaterThan(state.intervalDays)
    expect(part.intervalDays).toBeGreaterThan(state.intervalDays)
    expect(part.intervalDays).toBeLessThan(full.intervalDays)
    // No review happened: D/S, reps, lastReviewedAt all exactly as they were.
    expect(part.difficulty).toBe(state.difficulty)
    expect(part.stability).toBe(state.stability)
    expect(part.reps).toBe(state.reps)
    expect(part.lastReviewedAt).toBe(state.lastReviewedAt)
    expect(part.smartIntervalDays).toBe(part.intervalDays)   // active lane follows
  })

  it('recognition boosts move the reverse row lanes', () => {
    const rev = grad('c1', { reviewDirection: 'reverse', smartIntervalDays: null, smartDueAt: null, recallIntervalDays: 15, recallDueAt: iso(-1), intervalDays: 15 })
    const out = boostRow(rev, 'recognition', 0.4, deps)
    expect(out.recallIntervalDays).toBe(out.intervalDays)
    expect(out.intervalDays).toBeGreaterThanOrEqual(15)
  })
})

describe('creditRow — the final-stage real review', () => {
  it('full-strength credit does FSRS bookkeeping and grows the interval', () => {
    const state = grad('c1')
    const out = creditRow(state, 'production', 'good', 1, deps)
    expect(out.reps).toBe(state.reps + 1)
    expect(out.lastRating).toBe('good')
    expect(out.stability).toBeGreaterThan(state.stability!)
    expect(out.intervalDays).toBeGreaterThan(state.intervalDays)
  })

  it('a matching-only credit grows less than a full recall credit', () => {
    const state = grad('c1')
    const light = creditRow(state, 'production', 'good', 0.4, deps)
    const fullc = creditRow(state, 'production', 'good', 1, deps)
    expect(light.intervalDays).toBeLessThan(fullc.intervalDays)
    expect(light.intervalDays).toBeGreaterThanOrEqual(state.intervalDays)
    expect(light.stability).toBe(fullc.stability)   // memory model stays honest; only growth is capped
  })
})

describe('relearnReview — the real relearn gate, inside the session', () => {
  const looping = (over: Partial<CardState> = {}) =>
    grad('c1', { relearning: true, relearningStep: 1, goodStreak: 0, againStreak: 0, stability: 2, intervalDays: 2, smartIntervalDays: 2, ...over })

  it('first Good keeps looping; the second Good escapes and schedules', () => {
    const first = relearnReview(looping(), 'production', 'good', deps)
    expect(first.kind).toBe('looping')
    const s1 = (first as { state: CardState }).state
    expect(s1.goodStreak).toBe(1)
    expect(s1.relearning).toBe(true)
    const second = relearnReview(s1, 'production', 'good', deps)
    expect(second.kind).toBe('scheduled')
    const s2 = (second as { state: CardState }).state
    expect(s2.relearning).toBe(false)
    expect(s2.intervalDays).toBeGreaterThanOrEqual(1)
    expect(s2.smartIntervalDays).toBe(s2.intervalDays)
  })

  it('Easy escapes immediately; three Agains send it back to the pipeline', () => {
    expect(relearnReview(looping(), 'production', 'easy', deps).kind).toBe('scheduled')
    let st = looping()
    let out = relearnReview(st, 'production', 'again', deps)
    expect(out.kind).toBe('looping')
    st = (out as { state: CardState }).state
    out = relearnReview(st, 'production', 'again', deps)
    expect(out.kind).toBe('looping')
    st = (out as { state: CardState }).state
    expect(relearnReview(st, 'production', 'again', deps).kind).toBe('ladder')
  })

  it('never increments lapses — the lapse was counted entering the loop', () => {
    const out = relearnReview(looping({ lapses: 3 }), 'production', 'again', deps)
    expect((out as { state: CardState }).state.lapses).toBe(3)
  })
})

describe('buildProgramBatches', () => {
  const cards = [card('a'), card('b'), card('c'), card('d')]
  const forward = new Map<string, CardState>([
    ['a', grad('a')],                                     // due production
    ['b', grad('b', { relearning: true })],               // due but relearn-loop
    ['c', grad('c', { smartDueAt: iso(5), dueAt: iso(5) })], // not due
    ['d', grad('d')],                                     // due production + reverse below
  ])
  const reverse = new Map<string, CardState>([
    ['d', grad('d', { reviewDirection: 'reverse', smartIntervalDays: null, smartDueAt: null, recallDueAt: iso(-2), recallIntervalDays: 20 })],
  ])
  const tracks = new Map<string, EnabledTracks>([['fr|en', { typed: false, smart: true, recall: false, reverse: true } as EnabledTracks]])

  it('splits per direction; relearning rows ride along FLAGGED (same session, never a link-out)', () => {
    const batches = buildProgramBatches(cards, forward, reverse, tracks, NOW)
    const prod = batches.find(b => b.direction === 'production')!
    const rec  = batches.find(b => b.direction === 'recognition')!
    expect(prod.words.filter(w => !w.relearn).map(w => w.card.id).sort()).toEqual(['a', 'd'])
    expect(prod.words.filter(w => w.relearn).map(w => w.card.id)).toEqual(['b'])
    expect(prod.relearning).toBe(1)
    expect(rec.words.map(w => w.card.id)).toEqual(['d'])
  })

  it('a single-direction pair produces no recognition batch', () => {
    const single = new Map<string, EnabledTracks>([['fr|en', { typed: false, smart: true, recall: false, reverse: false } as EnabledTracks]])
    const batches = buildProgramBatches(cards, forward, reverse, single, NOW)
    expect(batches.some(b => b.direction === 'recognition')).toBe(false)
  })
})

describe('nextMatchingChunk', () => {
  const mk = (id: string, front = id, back = `${id}-g`): ProgramWord => ({ card: card(id, front, back), state: grad(id) })

  it('misses sprinkle in — an even share per remaining round, never one clumped redo', () => {
    const fresh = Array.from({ length: 12 }, (_, i) => mk(`f${i}`))
    const retry = Array.from({ length: 4 }, (_, i) => mk(`r${i}`))
    const chunk = nextMatchingChunk(fresh, retry, 8)         // 16 left → 2 rounds → 2 retries now
    expect(chunk).toHaveLength(8)
    expect(chunk.filter(w => w.card.id.startsWith('r'))).toHaveLength(2)
  })

  it('misses alone are simply the round when nothing fresh remains', () => {
    const retry = [mk('r0'), mk('r1'), mk('r2')]
    expect(nextMatchingChunk([], retry, 8).map(w => w.card.id)).toEqual(['r0', 'r1', 'r2'])
  })

  it('never puts identical tile text in one round; the collided word waits', () => {
    const words = [mk('x1', 'un', 'one'), mk('x2', 'deux', 'two'), mk('x3', 'dos', 'two')]
    const chunk = nextMatchingChunk(words, [], 8)
    expect(chunk.map(w => w.card.id)).toEqual(['x1', 'x2'])  // x3 shares the gloss "two"
  })

  it('tops up with retries when fresh words run short', () => {
    const chunk = nextMatchingChunk([mk('f0')], [mk('r0'), mk('r1')], 8)
    expect(chunk.map(w => w.card.id).sort()).toEqual(['f0', 'r0', 'r1'])
  })
})

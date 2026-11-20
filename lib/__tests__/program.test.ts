import { boostRow, creditRow, type ProgramDeps } from '../program'
import { buildProgramBatches, matchingChunks, type ProgramWord } from '../programPool'
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

  it('splits per direction, excludes relearning (counted) and not-due rows', () => {
    const batches = buildProgramBatches(cards, forward, reverse, tracks, NOW)
    const prod = batches.find(b => b.direction === 'production')!
    const rec  = batches.find(b => b.direction === 'recognition')!
    expect(prod.words.map(w => w.card.id).sort()).toEqual(['a', 'd'])
    expect(prod.relearning).toBe(1)
    expect(rec.words.map(w => w.card.id)).toEqual(['d'])
  })

  it('a single-direction pair produces no recognition batch', () => {
    const single = new Map<string, EnabledTracks>([['fr|en', { typed: false, smart: true, recall: false, reverse: false } as EnabledTracks]])
    const batches = buildProgramBatches(cards, forward, reverse, single, NOW)
    expect(batches.some(b => b.direction === 'recognition')).toBe(false)
  })
})

describe('matchingChunks', () => {
  it('chunks to size and never puts identical tile text in one round', () => {
    const words: ProgramWord[] = [
      { card: card('x1', 'un', 'one'), state: grad('x1') },
      { card: card('x2', 'deux', 'two'), state: grad('x2') },
      { card: card('x3', 'dos', 'two'), state: grad('x3') },     // duplicate gloss → later chunk
    ]
    const chunks = matchingChunks(words, 8)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]!.map(w => w.card.id)).toEqual(['x1', 'x2'])
    expect(chunks[1]!.map(w => w.card.id)).toEqual(['x3'])
    expect(matchingChunks(words, 2)[0]).toHaveLength(2)
  })
})

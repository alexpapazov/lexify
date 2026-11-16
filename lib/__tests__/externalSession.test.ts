import { parseSessionWords, matchSessionItems, statesForExternalRating, sessionStatus } from '../externalSession'
import { seedKnownStates, type RateDeps } from '../mediaRate'
import { CHIP_WINDOWS } from '../mediaIntake'
import { initialCardState } from '../../engine/pipeline'
import type { Card, CardState } from '@/domain'
import type { CardStateRepository } from '../data/interfaces'
import type { EnabledTracks } from '../sessionLimits'

const NOW = new Date('2026-11-15T12:00:00.000Z')
const iso = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()

function card(id: string, front: string, back: string, over: Partial<Card> = {}): Card {
  return {
    id, ownerId: 'u1', sourceLanguage: 'fr', targetLanguage: 'en',
    front, back, hints: [], choices: null, position: 0,
    createdAt: '', updatedAt: '', deletedAt: null, pos: 'noun',
    lemma: front.replace(/^(le|la|l')\s*/i, ''), ...over,
  }
}

function grad(cardId: string, over: Partial<CardState> = {}): CardState {
  return { ...initialCardState('u1', cardId, 'p'), graduated: true, difficulty: 5, stability: 60,
    smartIntervalDays: 60, smartDueAt: iso(20), intervalDays: 60, dueAt: iso(20), lastReviewedAt: iso(-40), reps: 6, ...over }
}

const deps: RateDeps = {
  userId: 'u1', src: 'fr', tgt: 'en', now: NOW,
  tracks: { typed: false, smart: true, recall: false, reverse: true } as EnabledTracks,
  retMap: new Map(), calMap: new Map(),
  stateRepo: {} as CardStateRepository, pipelineId: 'p', load: new Map<number, number>(),
}

describe('parseSessionWords', () => {
  it('splits lines, reads inline glosses, strips bullets, keeps unspaced hyphens', () => {
    const out = parseSessionWords('- s’absenter — to leave\n2. la berge\nporte-manteau: coat rack\nmot\tword')
    expect(out).toEqual([
      { word: 's’absenter', gloss: 'to leave' },
      { word: 'la berge', gloss: null },
      { word: 'porte-manteau', gloss: 'coat rack' },
      { word: 'mot', gloss: 'word' },
    ])
  })

  it('dedupes by normalized key and splits a single comma line', () => {
    expect(parseSessionWords("s'absenter, s’absenter, berge").map(w => w.word)).toEqual(["s'absenter", 'berge'])
  })
})

describe('matchSessionItems + sessionStatus', () => {
  const cards = [card('c-long', 'le sentier', 'path'), card('c-never', 'la mousse', 'moss'), card('c-learn', 'le roc', 'rock')]
  const forward = new Map<string, CardState>([
    ['c-long', grad('c-long')],
    ['c-learn', { ...initialCardState('u1', 'c-learn', 'p'), reps: 2, currentStepOrder: 1 }],
  ])
  const items = matchSessionItems(
    [{ word: 'sentier', gloss: null }, { word: 'mousse', gloss: null }, { word: 'roc', gloss: null }, { word: 'inconnu', gloss: 'unknown' }],
    cards, forward, 'fr', 'en',
  )

  it('matches lemma-primary and classifies by the forward row', () => {
    expect(items.map(it => it.status)).toEqual(['longterm', 'never', 'learning', 'new'])
    expect(items[0]!.existingFront).toBe('le sentier')
    expect(items[3]!.existingId).toBeNull()
    expect(items[3]!.gloss).toBe('unknown')               // pasted gloss survives
    expect(items.every(it => it.bucket === 'fresh')).toBe(true)  // pre-painted "just learned"
  })

  it('short-term graduated cards read shortterm', () => {
    expect(sessionStatus(grad('x', { smartIntervalDays: 10, intervalDays: 10 }))).toBe('shortterm')
  })
})

describe('statesForExternalRating — graduated cards', () => {
  it('fresh pins BOTH rows into the 2–4 day window with one shared offset', () => {
    const fwd = grad('c1')
    const rev = grad('c1', { reviewDirection: 'reverse', smartIntervalDays: null, smartDueAt: null, recallIntervalDays: 70, recallDueAt: iso(25) })
    const out = statesForExternalRating(fwd, rev, 'fresh', deps)
    expect(out).toHaveLength(2)
    for (const s of out) {
      expect(s.intervalDays).toBeGreaterThanOrEqual(2)
      expect(s.intervalDays).toBeLessThanOrEqual(4)
      expect(s.relearning).toBe(false)
    }
    expect(out[0]!.intervalDays).toBe(out[1]!.intervalDays)           // side by side
    expect(out[0]!.smartIntervalDays).toBe(out[0]!.intervalDays)      // active lane moved
    expect(out[1]!.recallIntervalDays).toBe(out[1]!.intervalDays)
    expect(out[0]!.stability).toBeLessThan(fwd.stability!)            // reseeded to the window
  })

  it('short = a real Good review: interval advances, reps count, lanes follow', () => {
    const fwd = grad('c1')
    const [s] = statesForExternalRating(fwd, undefined, 'short', deps)
    expect(s!.intervalDays).toBeGreaterThan(fwd.intervalDays)
    expect(s!.reps).toBe(fwd.reps + 1)
    expect(s!.lastRating).toBe('good')
    expect(s!.lapses).toBe(fwd.lapses)                                // no penalty anywhere
    expect(s!.smartDueAt).toBe(s!.dueAt)
  })

  it('long = Easy grows at least as much as Good', () => {
    const good = statesForExternalRating(grad('c1'), undefined, 'short', deps)[0]!
    const easy = statesForExternalRating(grad('c1'), undefined, 'long', deps)[0]!
    expect(easy.intervalDays).toBeGreaterThanOrEqual(good.intervalDays)
    expect(easy.lastRating).toBe('easy')
  })

  it('dormant and non-graduated rows are left alone', () => {
    expect(statesForExternalRating(grad('c1', { dormant: true }), undefined, 'short', deps)).toHaveLength(0)
    expect(statesForExternalRating(initialCardState('u1', 'c1', 'p'), undefined, 'short', deps)).toHaveLength(0)
  })
})

describe('the fresh seed bucket', () => {
  it('CHIP_WINDOWS.fresh is the 2–4 day "just learned" window', () => {
    expect(CHIP_WINDOWS.fresh).toEqual({ min: 2, max: 4, center: 3 })
  })

  it('seedKnownStates accepts fresh: graduated bulk_known rows due within days', () => {
    const [fwd, rev] = seedKnownStates('c1', 'fresh', undefined, undefined, deps)
    for (const s of [fwd!, rev!]) {
      expect(s.graduated).toBe(true)
      expect(s.acceleratedMode).toBe('bulk_known')
      expect(s.intervalDays).toBeGreaterThanOrEqual(2)
      expect(s.intervalDays).toBeLessThanOrEqual(4)
    }
  })
})

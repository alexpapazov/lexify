import {
  resolveTargets, addDays, splitList, DEFAULT_CAP_PER_SOURCE,
  type SelectionContext, type TargetSource,
} from '../practiceSelect'
import type { Card, CardState, PartOfSpeech } from '@/domain'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

let nextId = 0
function card(front: string, pos: PartOfSpeech | null = 'noun', lemma: string | null = front): Card {
  return {
    id: `card-${nextId++}`,
    ownerId: 'user-1',
    sourceLanguage: 'fr',
    targetLanguage: 'en',
    front, back: `gloss of ${front}`, hints: [], choices: null, position: 0,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', deletedAt: null,
    pos, lemma,
  }
}

function state(cardId: string, over: Partial<CardState> = {}): CardState {
  return {
    cardId, graduated: true, reviewDirection: 'forward',
    dueAt: null, difficulty: null, lapses: 0,
    ...over,
  } as unknown as CardState
}

/** A context with sensible empties; each test overrides what it needs. */
function ctx(over: Partial<SelectionContext> & { cards: Card[] }): SelectionContext {
  return {
    statesByCard: new Map(),
    cardIdsByDeck: new Map(),
    deckIdsByFolder: new Map(),
    today: '2026-08-08',
    // Stand-in for normalizeFrontKey: lowercase, strip a leading French article.
    normalizeKey: (t: string) => t.trim().toLowerCase().replace(/^(le|la|les|un|une|l')\s*/, ''),
    ...over,
  }
}

function statesOf(entries: [string, Partial<CardState>][]): Map<string, CardState> {
  return new Map(entries.map(([id, over]) => [id, state(id, over)]))
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

describe('addDays', () => {
  it('adds days without timezone drift', () => {
    expect(addDays('2026-08-08', 7)).toBe('2026-08-15')
    expect(addDays('2026-08-08', 0)).toBe('2026-08-08')
  })

  it('rolls over month and year boundaries', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })

  it('handles a leap day', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29')
  })
})

describe('splitList', () => {
  it('splits on newlines, commas and semicolons, trimming blanks', () => {
    expect(splitList('pluie\n vent ,, orage;\n\nneige ')).toEqual(['pluie', 'vent', 'orage', 'neige'])
  })

  it('returns nothing for empty text', () => {
    expect(splitList('   \n  ')).toEqual([])
  })
})

// ─── manual ───────────────────────────────────────────────────────────────────

describe('manual source', () => {
  it('returns exactly the named cards, in order', () => {
    const a = card('pluie'), b = card('vent')
    const result = resolveTargets([{ type: 'manual', cardIds: [b.id, a.id] }], ctx({ cards: [a, b] }))
    expect(result.targets.map(t => t.front)).toEqual(['vent', 'pluie'])
  })

  it('ignores ids that aren’t in the library', () => {
    const a = card('pluie')
    const result = resolveTargets([{ type: 'manual', cardIds: [a.id, 'ghost'] }], ctx({ cards: [a] }))
    expect(result.targets).toHaveLength(1)
  })

  it('is never capped — an explicit choice is honoured in full', () => {
    const many = Array.from({ length: DEFAULT_CAP_PER_SOURCE + 20 }, (_, i) => card(`mot${i}`))
    const result = resolveTargets(
      [{ type: 'manual', cardIds: many.map(c => c.id) }], ctx({ cards: many }))
    expect(result.targets).toHaveLength(many.length)
    expect(result.capped).toEqual([])
  })
})

// ─── decks / folders ──────────────────────────────────────────────────────────

describe('decks and folders sources', () => {
  const a = card('pluie'), b = card('vent'), c = card('orage')

  it('collects the cards of the selected decks', () => {
    const result = resolveTargets([{ type: 'decks', deckIds: ['d1'] }], ctx({
      cards: [a, b, c],
      cardIdsByDeck: new Map([['d1', [a.id, b.id]], ['d2', [c.id]]]),
    }))
    expect(result.targets.map(t => t.front)).toEqual(['pluie', 'vent'])
  })

  it('expands a folder to its descendant decks', () => {
    const result = resolveTargets([{ type: 'folders', folderIds: ['f1'] }], ctx({
      cards: [a, b, c],
      cardIdsByDeck: new Map([['d1', [a.id]], ['d2', [b.id]], ['d3', [c.id]]]),
      deckIdsByFolder: new Map([['f1', ['d1', 'd2']]]),
    }))
    expect(result.targets.map(t => t.front)).toEqual(['pluie', 'vent'])
  })

  it('caps a big deck and reports that it did', () => {
    const many = Array.from({ length: DEFAULT_CAP_PER_SOURCE + 10 }, (_, i) => card(`mot${i}`))
    const result = resolveTargets([{ type: 'decks', deckIds: ['d1'] }], ctx({
      cards: many,
      cardIdsByDeck: new Map([['d1', many.map(m => m.id)]]),
    }))
    expect(result.targets).toHaveLength(DEFAULT_CAP_PER_SOURCE)
    expect(result.capped).toEqual(['decks'])
  })

  it('does not spend the cap on cards the gate rejects', () => {
    // 5 unlabeled cards first, then 3 good ones, with a cap of 3: all 3 good ones must survive.
    const junk = Array.from({ length: 5 }, () => card('inconnu', null, null))
    const good = [card('pluie'), card('vent'), card('orage')]
    const all = [...junk, ...good]
    const result = resolveTargets([{ type: 'decks', deckIds: ['d1'] }], ctx({
      cards: all,
      cardIdsByDeck: new Map([['d1', all.map(c2 => c2.id)]]),
    }), 3)
    expect(result.targets.map(t => t.front)).toEqual(['pluie', 'vent', 'orage'])
    expect(result.droppedUnlabeled).toBe(5)
  })
})

// ─── due ──────────────────────────────────────────────────────────────────────

describe('due source', () => {
  const soon = card('pluie'), later = card('vent'), overdue = card('orage'), unrated = card('neige')

  const dueCtx = ctx({
    cards: [soon, later, overdue, unrated],
    statesByCard: statesOf([
      [soon.id,    { dueAt: '2026-08-10T12:00:00Z' }],
      [later.id,   { dueAt: '2026-09-20T12:00:00Z' }],
      [overdue.id, { dueAt: '2026-07-01T12:00:00Z' }],
      [unrated.id, { graduated: false, dueAt: '2026-08-09T12:00:00Z' }],
    ]),
  })

  it('includes cards falling due inside the window', () => {
    const result = resolveTargets([{ type: 'due', withinDays: 7 }], dueCtx)
    expect(result.targets.map(t => t.front)).toContain('pluie')
    expect(result.targets.map(t => t.front)).not.toContain('vent')
  })

  it('includes overdue cards, soonest first', () => {
    const result = resolveTargets([{ type: 'due', withinDays: 7 }], dueCtx)
    expect(result.targets.map(t => t.front)).toEqual(['orage', 'pluie'])
  })

  it('excludes cards that never graduated — they are not review-scheduled', () => {
    const result = resolveTargets([{ type: 'due', withinDays: 7 }], dueCtx)
    expect(result.targets.map(t => t.front)).not.toContain('neige')
  })

  it('a zero-day window still catches today and everything overdue', () => {
    const result = resolveTargets([{ type: 'due', withinDays: 0 }], dueCtx)
    expect(result.targets.map(t => t.front)).toEqual(['orage'])
  })
})

// ─── difficulty ───────────────────────────────────────────────────────────────

describe('difficulty source', () => {
  const hard = card('pluie'), mid = card('vent'), easy = card('orage'), unrated = card('neige')

  const hardCtx = ctx({
    cards: [hard, mid, easy, unrated],
    statesByCard: statesOf([
      [hard.id,    { difficulty: 9.1 }],
      [mid.id,     { difficulty: 5.5 }],
      [easy.id,    { difficulty: 2.0 }],
      [unrated.id, { difficulty: null }],
    ]),
  })

  it('returns the hardest cards first, honouring the limit', () => {
    const result = resolveTargets([{ type: 'difficulty', limit: 2 }], hardCtx)
    expect(result.targets.map(t => t.front)).toEqual(['pluie', 'vent'])
  })

  it('skips cards with no difficulty rather than treating them as easy', () => {
    const result = resolveTargets([{ type: 'difficulty', limit: 10 }], hardCtx)
    expect(result.targets.map(t => t.front)).not.toContain('neige')
  })

  it('breaks ties on lapses', () => {
    const a = card('un'), b = card('deux')
    const result = resolveTargets([{ type: 'difficulty', limit: 2 }], ctx({
      cards: [a, b],
      statesByCard: statesOf([
        [a.id, { difficulty: 6, lapses: 1 }],
        [b.id, { difficulty: 6, lapses: 9 }],
      ]),
    }))
    expect(result.targets.map(t => t.front)).toEqual(['deux', 'un'])
  })
})

// ─── list ─────────────────────────────────────────────────────────────────────

describe('list source', () => {
  const pluie = card('la pluie', 'noun', 'pluie'), vent = card('le vent', 'noun', 'vent')

  it('matches pasted words through the normalizer, and reports the misses', () => {
    const result = resolveTargets([{ type: 'list', text: 'pluie\nvent\ntonnerre' }],
      ctx({ cards: [pluie, vent] }))
    expect(result.targets.map(t => t.front)).toEqual(['la pluie', 'le vent'])
    expect(result.unmatched).toEqual(['tonnerre'])
  })

  it('matches regardless of a leading article on either side', () => {
    const result = resolveTargets([{ type: 'list', text: 'la pluie' }], ctx({ cards: [pluie] }))
    expect(result.targets).toHaveLength(1)
  })

  it('keeps the pasted order', () => {
    const result = resolveTargets([{ type: 'list', text: 'vent, pluie' }], ctx({ cards: [pluie, vent] }))
    expect(result.targets.map(t => t.front)).toEqual(['le vent', 'la pluie'])
  })
})

// ─── Composition and reporting ────────────────────────────────────────────────

describe('composing sources', () => {
  const a = card('pluie'), b = card('vent'), c = card('orage')

  it('unions sources in order, without duplicating a card claimed twice', () => {
    const sources: TargetSource[] = [
      { type: 'decks', deckIds: ['d1'] },
      { type: 'manual', cardIds: [b.id, c.id] },
    ]
    const result = resolveTargets(sources, ctx({
      cards: [a, b, c],
      cardIdsByDeck: new Map([['d1', [a.id, b.id]]]),
    }))
    expect(result.targets.map(t => t.front)).toEqual(['pluie', 'vent', 'orage'])
  })

  it('counts each rejected card once, whichever source found it', () => {
    const phrase = card('il pleut des cordes', 'phrase', null)
    const result = resolveTargets([
      { type: 'decks', deckIds: ['d1'] },
      { type: 'manual', cardIds: [phrase.id] },
    ], ctx({
      cards: [a, phrase],
      cardIdsByDeck: new Map([['d1', [a.id, phrase.id]]]),
    }))
    expect(result.droppedUndrillable).toBe(1)
    expect(result.targets.map(t => t.front)).toEqual(['pluie'])
  })

  it('separates the two rejection reasons', () => {
    const unlabeled = card('inconnu', null, null)
    const article   = card('le', 'determiner', 'le')
    const result = resolveTargets(
      [{ type: 'manual', cardIds: [a.id, unlabeled.id, article.id] }],
      ctx({ cards: [a, unlabeled, article] }))
    expect(result.droppedUnlabeled).toBe(1)
    expect(result.droppedUndrillable).toBe(1)
  })

  it('returns an empty result for no sources', () => {
    const result = resolveTargets([], ctx({ cards: [a] }))
    expect(result).toEqual({
      targets: [], droppedUnlabeled: 0, droppedUndrillable: 0, unmatched: [], capped: [],
    })
  })
})

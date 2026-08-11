import {
  alreadyThere, destinationsFromPlan, planMovesFromDocument, planMovesFromAssignments,
  groupByDestination, destinationKey,
} from '../cardOrganizer'
import type { ScopedCard } from '../cardEditor'
import type { DeckPlan } from '@/lib/docx'

const card = (over: Partial<ScopedCard> = {}): ScopedCard => ({
  deckId: 'd1', cardId: 'c1', front: 'el pan', back: 'bread',
  sourceLanguage: 'es', deckName: 'Misc', ...over,
})

/** Library shape: d1 = "Misc" at the root, d2 = "Food / Ingredients". */
const deckPathOf = (deckId: string): string[] =>
  deckId === 'd2' ? ['Food', 'Ingredients'] : deckId === 'd3' ? ['Food', 'Drinks'] : ['Misc']

const plan = (decks: DeckPlan['decks']): DeckPlan => ({ decks, unparsed: [] })

describe('alreadyThere', () => {
  it('matches a card sitting exactly where the destination says', () => {
    expect(alreadyThere(card({ deckId: 'd2' }), { path: ['Food'], deck: 'Ingredients' }, deckPathOf)).toBe(true)
  })

  it('ignores case and surrounding whitespace', () => {
    expect(alreadyThere(card({ deckId: 'd2' }), { path: ['  food '], deck: 'INGREDIENTS' }, deckPathOf)).toBe(true)
  })

  it('is false when the depth differs, even if the deck name matches', () => {
    expect(alreadyThere(card({ deckId: 'd2' }), { path: [], deck: 'Ingredients' }, deckPathOf)).toBe(false)
  })
})

describe('destinationsFromPlan', () => {
  it('maps every word to the deck it appears under', () => {
    const { byFront } = destinationsFromPlan(plan([
      { path: ['Food'], name: 'Ingredients', cards: [{ front: 'el pan', back: 'bread' }] },
      { path: ['Food'], name: 'Drinks',      cards: [{ front: 'el vino', back: 'wine' }] },
    ]), 'es')
    expect(byFront.get('pan')).toEqual({ path: ['Food'], deck: 'Ingredients' })
    expect(byFront.get('vino')).toEqual({ path: ['Food'], deck: 'Drinks' })
  })

  it('normalizes the key, so an article or capital does not miss a match', () => {
    const { byFront } = destinationsFromPlan(plan([
      { path: [], name: 'Nouns', cards: [{ front: 'El Pan', back: 'bread' }] },
    ]), 'es')
    expect(byFront.has('pan')).toBe(true)
  })

  it('keeps the FIRST placement of a word listed twice, and reports the rest', () => {
    const { byFront, duplicates } = destinationsFromPlan(plan([
      { path: ['Food'], name: 'Ingredients', cards: [{ front: 'el pan', back: 'bread' }] },
      { path: ['Basics'], name: 'Week 1',    cards: [{ front: 'el pan', back: 'bread' }] },
    ]), 'es')
    expect(byFront.get('pan')).toEqual({ path: ['Food'], deck: 'Ingredients' })
    expect(duplicates).toEqual(['el pan'])
  })
})

describe('planMovesFromDocument', () => {
  const doc = plan([
    { path: ['Food'], name: 'Ingredients', cards: [{ front: 'el pan', back: 'bread' }] },
    { path: ['Food'], name: 'Drinks',      cards: [{ front: 'el vino', back: 'wine' }] },
  ])

  it('proposes a move for a card the document places elsewhere', () => {
    const { moves } = planMovesFromDocument([card()], doc, deckPathOf)
    expect(moves).toHaveLength(1)
    expect(moves[0]!.to).toEqual({ path: ['Food'], deck: 'Ingredients' })
    expect(moves[0]!.fromDeckName).toBe('Misc')
  })

  it('proposes NOTHING for a card already in the right deck', () => {
    const { moves } = planMovesFromDocument([card({ deckId: 'd2' })], doc, deckPathOf)
    expect(moves).toEqual([])
  })

  it('leaves cards the document never mentions alone, and reports them', () => {
    const stray = card({ cardId: 'c9', front: 'la mesa', back: 'table' })
    const { moves, unmatched } = planMovesFromDocument([stray], doc, deckPathOf)
    expect(moves).toEqual([])
    expect(unmatched.map(c => c.cardId)).toEqual(['c9'])
  })

  it('matches through articles and case differences between card and document', () => {
    const { moves } = planMovesFromDocument([card({ front: 'Pan' })], doc, deckPathOf)
    expect(moves).toHaveLength(1)
    expect(moves[0]!.to.deck).toBe('Ingredients')
  })

  it('gives every proposal a stable, unique id', () => {
    const cards = [card(), card({ cardId: 'c2', front: 'el vino' })]
    const { moves } = planMovesFromDocument(cards, doc, deckPathOf)
    expect(new Set(moves.map(m => m.id)).size).toBe(moves.length)
    expect(planMovesFromDocument(cards, doc, deckPathOf).moves.map(m => m.id)).toEqual(moves.map(m => m.id))
  })
})

describe('planMovesFromAssignments', () => {
  const cards = [card(), card({ cardId: 'c2', front: 'el vino', back: 'wine' })]

  it('turns a path into a folder path plus a deck name', () => {
    const moves = planMovesFromAssignments(cards, [{ cardId: 'c1', path: ['Food', 'Ingredients'] }], deckPathOf)
    expect(moves[0]!.to).toEqual({ path: ['Food'], deck: 'Ingredients' })
  })

  it('treats a single-element path as a deck at the library root', () => {
    const moves = planMovesFromAssignments(cards, [{ cardId: 'c1', path: ['Verbs'] }], deckPathOf)
    expect(moves[0]!.to).toEqual({ path: [], deck: 'Verbs' })
  })

  it('DROPS an id that is not in the batch — never trusts an invented card', () => {
    expect(planMovesFromAssignments(cards, [{ cardId: 'nope', path: ['Food'] }], deckPathOf)).toEqual([])
  })

  it('drops an empty or blank-only path rather than creating a nameless folder', () => {
    expect(planMovesFromAssignments(cards, [{ cardId: 'c1', path: [] }], deckPathOf)).toEqual([])
    expect(planMovesFromAssignments(cards, [{ cardId: 'c1', path: ['  ', ''] }], deckPathOf)).toEqual([])
  })

  it('drops a no-op assignment (card already there)', () => {
    const here = [card({ deckId: 'd2' })]
    expect(planMovesFromAssignments(here, [{ cardId: 'c1', path: ['Food', 'Ingredients'] }], deckPathOf)).toEqual([])
  })

  it('keeps the model reason when given, and falls back to a readable one', () => {
    const withReason = planMovesFromAssignments(cards, [{ cardId: 'c1', path: ['Food'], reason: 'It is a food.' }], deckPathOf)
    expect(withReason[0]!.reason).toBe('It is a food.')
    const without = planMovesFromAssignments(cards, [{ cardId: 'c1', path: ['Food'] }], deckPathOf)
    expect(without[0]!.reason).toContain('Food')
  })
})

describe('groupByDestination', () => {
  it('collects moves sharing a destination, preserving first-seen order', () => {
    const moves = planMovesFromAssignments(
      [card(), card({ cardId: 'c2', front: 'el vino' }), card({ cardId: 'c3', front: 'la mesa' })],
      [
        { cardId: 'c1', path: ['Food', 'Ingredients'] },
        { cardId: 'c3', path: ['Home'] },
        { cardId: 'c2', path: ['Food', 'Ingredients'] },
      ],
      deckPathOf,
    )
    const groups = groupByDestination(moves)
    expect(groups.map(g => g.key)).toEqual(['Food / Ingredients', 'Home'])
    expect(groups[0]!.moves.map(m => m.cardId)).toEqual(['c1', 'c2'])
  })
})

describe('destinationKey', () => {
  it('reads root-first with the deck last', () => {
    expect(destinationKey({ path: ['Food', 'Sweet'], deck: 'Desserts' })).toBe('Food / Sweet / Desserts')
    expect(destinationKey({ path: [], deck: 'Verbs' })).toBe('Verbs')
  })
})

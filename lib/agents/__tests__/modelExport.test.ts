import type { Deck, Folder } from '@/domain'
import type { OutOfScopeCard, ScopeCard } from '../migrationPlan'
import {
  buildModelLibrary, translateSteps, resolveDocMoves, leftoverCards, movesToSteps,
  collectDestinations, sectionKey,
} from '../modelExport'

const folder = (id: string, name: string, parentId: string | null = null): Folder =>
  ({ id, name, parentId, sourceLanguage: 'it', targetLanguage: 'en' } as unknown as Folder)
const deck = (id: string, name: string, folderId: string | null = null): Deck =>
  ({ id, name, folderId, sourceLanguage: 'it', targetLanguage: 'en' } as unknown as Deck)
const card = (cardId: string, front: string, deckId: string, deckName: string, back = 'x'): ScopeCard =>
  ({ cardId, front, back, deckId, deckName, sourceLanguage: 'it' })

const FOLDERS = [folder('F1', 'Food'), folder('F2', 'Fruit', 'F1')]
const DECKS = [deck('D1', 'Apples', 'F2'), deck('D2', 'Misc')]
const CARDS = [card('C1', 'la mela', 'D1', 'Apples', 'apple'), card('C2', 'il cane', 'D2', 'Misc', 'dog')]

describe('buildModelLibrary', () => {
  const lib = buildModelLibrary(FOLDERS, DECKS, ['D1', 'D2'], CARDS)

  it('renders the tree with short ids and card lines', () => {
    expect(lib.fullText).toContain('Food/ [f1]')
    expect(lib.fullText).toContain('Fruit/ [f2]')
    expect(lib.fullText).toMatch(/Apples \[d\d\] \(1 cards\)/)
    expect(lib.fullText).toMatch(/\d+: la mela = apple/)
  })

  it('the tree text has the structure but NO card lines', () => {
    expect(lib.treeText).toContain('Apples')
    expect(lib.treeText).not.toContain('la mela')
  })

  it('never leaks a real id into the model text', () => {
    expect(lib.fullText).not.toContain('D1')
    expect(lib.fullText).not.toContain('F1')
    expect(lib.fullText).not.toContain('C1')
  })

  it('maps short ids back to real records, and deck paths include ancestors', () => {
    const shortDeck = [...lib.deckIds.entries()].find(([, real]) => real === 'D1')![0]
    expect(shortDeck).toMatch(/^d\d+$/)
    expect(lib.deckPaths.get('D1')).toEqual(['Food', 'Fruit', 'Apples'])
    expect(lib.deckPaths.get('D2')).toEqual(['Misc'])
  })

  it('excludes folders that hold no scoped deck', () => {
    const lonely = [...FOLDERS, folder('F9', 'Empty')]
    const built = buildModelLibrary(lonely, DECKS, ['D1', 'D2'], CARDS)
    expect(built.fullText).not.toContain('Empty')
  })

  it('gives a shared card one id PER LINK, and numbers pull-ins after scope cards', () => {
    const shared = [card('C1', 'la mela', 'D1', 'Apples'), card('C1', 'la mela', 'D2', 'Misc')]
    const pull: OutOfScopeCard[] = [{ cardId: 'C9', front: 'il sole', back: 'sun', deckId: 'D9', deckName: 'Sky', sourceLanguage: 'it' }]
    const built = buildModelLibrary(FOLDERS, DECKS, ['D1', 'D2'], shared, pull)
    const links = [...built.links.values()]
    expect(links.filter(l => l.cardId === 'C1')).toHaveLength(2)
    const pullLink = links.find(l => l.pullIn)
    expect(pullLink).toMatchObject({ cardId: 'C9', deckId: 'D9' })
  })
})

describe('translateSteps', () => {
  const lib = buildModelLibrary(FOLDERS, DECKS, ['D1', 'D2'], CARDS,
    [{ cardId: 'C9', front: 'il sole', back: 'sun', deckId: 'D9', deckName: 'Sky', sourceLanguage: 'it' }])
  const shortOf = (real: string) => [...lib.links.entries()].find(([, l]) => l.cardId === real)![0]

  it('rewrites short ids to real ids and fills the echo fields from OUR data', () => {
    const steps = translateSteps([
      { kind: 'moveCard', cardId: shortOf('C1'), toDeck: ['Verbs'], front: 'LIES', back: 'LIES', reason: 'r' },
    ], lib, DECKS, FOLDERS)
    expect(steps[0]).toMatchObject({
      kind: 'moveCard', cardId: 'C1', front: 'la mela', back: 'apple',
      fromDeckId: 'D1', fromDeckName: 'Apples', toDeck: ['Verbs'],
    })
  })

  it('marks a pull-in link as pullIn without the model saying so', () => {
    const steps = translateSteps([{ kind: 'moveCard', cardId: shortOf('C9'), toDeck: ['Sky'] }], lib, DECKS, FOLDERS)
    expect(steps[0]).toMatchObject({ cardId: 'C9', pullIn: true, fromDeckId: 'D9' })
  })

  it('passes an invented id through for the validator to drop', () => {
    const steps = translateSteps([{ kind: 'moveCard', cardId: '99999', toDeck: ['X'] }], lib, DECKS, FOLDERS)
    expect((steps[0] as { cardId: string }).cardId).toBe('99999')
  })

  it('translates deck and folder ids, filling names from the real records', () => {
    const dShort = [...lib.deckIds.entries()].find(([, r]) => r === 'D2')![0]
    const fShort = [...lib.folderIds.entries()].find(([, r]) => r === 'F2')![0]
    const steps = translateSteps([
      { kind: 'moveDeck', deckId: dShort, toFolder: ['Food'] },
      { kind: 'moveFolder', folderId: fShort, toParent: [] },
      { kind: 'createFolder', path: [' Trimmed ', ''] },
    ], lib, DECKS, FOLDERS)
    expect(steps[0]).toMatchObject({ kind: 'moveDeck', deckId: 'D2', deckName: 'Misc' })
    expect(steps[1]).toMatchObject({ kind: 'moveFolder', folderId: 'F2', folderName: 'Fruit' })
    expect(steps[2]).toMatchObject({ kind: 'createFolder', path: ['Trimmed'] })
  })
})

describe('resolveDocMoves', () => {
  const lib = buildModelLibrary(FOLDERS, DECKS, ['D1', 'D2'], CARDS)
  const docs = [{
    name: 'list.docx',
    sections: [{ path: ['Animals'], name: 'Pets', cards: [{ front: 'Il Cane', back: 'dog' }, { front: 'lo zzz', back: '?' }] }],
  }]

  it('moves a scope card to the routed destination, deterministically', () => {
    const { steps } = resolveDocMoves({
      documents: docs,
      sectionRoutes: [{ section: 'Animals / Pets', toDeck: ['Zoo', 'Dogs'] }],
      scopeCards: CARDS, pullIn: [], deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ cardId: 'C2', toDeck: ['Zoo', 'Dogs'], fromDeckId: 'D2' })
  })

  it('falls back to the section’s own path when no route was given', () => {
    const { steps } = resolveDocMoves({
      documents: docs, sectionRoutes: [],
      scopeCards: CARDS, pullIn: [], deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    expect(steps[0]!.kind === 'moveCard' && steps[0]!.toDeck).toEqual(['Animals', 'Pets'])
  })

  it('skips a card already exactly at its destination, but still claims it', () => {
    const { steps, claimedKeys } = resolveDocMoves({
      documents: [{ name: 'd', sections: [{ path: [], name: 'Misc', cards: [{ front: 'il cane', back: 'dog' }] }] }],
      sectionRoutes: [], scopeCards: CARDS, pullIn: [], deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    expect(steps).toEqual([])
    expect(claimedKeys.size).toBe(1)
  })

  it('pulls in an out-of-scope match with pullIn set', () => {
    const { steps } = resolveDocMoves({
      documents: [{ name: 'd', sections: [{ path: [], name: 'Sky', cards: [{ front: 'il sole', back: 'sun' }] }] }],
      sectionRoutes: [], scopeCards: CARDS,
      pullIn: [{ cardId: 'C9', front: 'il sole', back: 'sun', deckId: 'D9', deckName: 'SkyDeck', sourceLanguage: 'it' }],
      deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    expect(steps[0]).toMatchObject({ cardId: 'C9', pullIn: true, fromDeckId: 'D9', toDeck: ['Sky'] })
  })

  it('the first section to claim a word wins; a missing word produces nothing', () => {
    const two = [{
      name: 'd', sections: [
        { path: [], name: 'A', cards: [{ front: 'il cane', back: 'dog' }] },
        { path: [], name: 'B', cards: [{ front: 'il cane', back: 'dog' }] },
      ],
    }]
    const { steps } = resolveDocMoves({
      documents: two, sectionRoutes: [], scopeCards: CARDS, pullIn: [], deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    expect(steps).toHaveLength(1)
    expect(steps[0]!.kind === 'moveCard' && steps[0]!.toDeck).toEqual(['A'])
  })
})

describe('leftoverCards / movesToSteps / collectDestinations', () => {
  const lib = buildModelLibrary(FOLDERS, DECKS, ['D1', 'D2'], CARDS)

  it('leftovers are the unclaimed scope cards, deduped by card', () => {
    const { claimedKeys } = resolveDocMoves({
      documents: [{ name: 'd', sections: [{ path: [], name: 'X', cards: [{ front: 'il cane', back: 'dog' }] }] }],
      sectionRoutes: [], scopeCards: CARDS, pullIn: [], deckPaths: lib.deckPaths, sourceLanguage: 'it',
    })
    const left = leftoverCards(CARDS, claimedKeys, 'it')
    expect(left.map(c => c.cardId)).toEqual(['C1'])
  })

  it('translates assignment answers, skipping malformed and already-there entries', () => {
    const batch = [CARDS[0]!, CARDS[1]!]
    const destinations = [['Zoo'], ['Misc']]
    const steps = movesToSteps(
      [{ id: 0, to: 0 }, { id: 1, to: 1 }, { id: 7, to: 0 }, { id: 0, to: 99 }, 'junk'],
      batch, destinations, lib.deckPaths,
    )
    // id 1 → Misc is where il cane already lives; id 7/99/junk invalid.
    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ cardId: 'C1', toDeck: ['Zoo'] })
  })

  it('collects a deduped destination menu from routes, steps, and existing decks', () => {
    const dests = collectDestinations({
      sectionRoutes: [{ section: 's', toDeck: ['Zoo', 'Dogs'] }, { section: 't', toDeck: ['zoo', 'dogs'] }],
      structureSteps: [{ kind: 'moveDeck', deckId: 'D2', deckName: 'Misc', toFolder: ['Box'], reason: '' }],
      deckPaths: lib.deckPaths,
    })
    const joined = dests.map(d => d.join(' / '))
    expect(joined).toContain('Zoo / Dogs')
    expect(joined.filter(j => j.toLowerCase() === 'zoo / dogs')).toHaveLength(1) // deduped
    expect(joined).toContain('Box / Misc')
    expect(joined).toContain('Food / Fruit / Apples')
  })

  it('sectionKey joins path and name', () => {
    expect(sectionKey({ path: ['A', 'B'], name: 'C', cards: [] })).toBe('A / B / C')
  })
})

import {
  diagnose, applyPolicy, orderSteps, validatePlan, groupPlan, countCardMoves,
  type MigrationStep, type ScopeCard, type OutOfScopeCard, type DiagnosticPolicy,
} from '../migrationPlan'

const card = (cardId: string, front: string, deckName: string, deckId = 'd1'): ScopeCard =>
  ({ cardId, front, back: 'x', deckId, deckName, sourceLanguage: 'it' })

const ALLOW: DiagnosticPolicy = { ignoreDuplicates: false, ignoreMissing: false, allowPullIn: true }

describe('diagnose', () => {
  it('flags the same word on two different cards in scope', () => {
    const d = diagnose([card('c1', 'il gatto', 'Animals'), card('c2', 'il gatto', 'Pets', 'd2')], [], [], 'it')
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'duplicate', word: 'il gatto' })
    expect(d[0]!.detail).toContain('Animals')
    expect(d[0]!.detail).toContain('Pets')
  })

  it('does NOT call a shared card a duplicate of itself', () => {
    // One card linked into two decks is one card in two places, not two cards.
    const shared = [card('c1', 'il gatto', 'Animals'), card('c1', 'il gatto', 'Pets', 'd2')]
    expect(diagnose(shared, [], [], 'it')).toEqual([])
  })

  it('matches words the way the rest of the app does — case, articles, grammatical tags', () => {
    const d = diagnose([card('c1', 'il gatto', 'A'), card('c2', 'Gatto (m)', 'B', 'd2')], [], [], 'it')
    expect(d.map(x => x.kind)).toEqual(['duplicate'])
  })

  it('reports a document word that exists elsewhere in the library as out-of-scope, not missing', () => {
    const outside: OutOfScopeCard[] = [{ cardId: 'c9', front: 'la mela', back: 'apple', deckId: 'd9', deckName: 'Fruit', sourceLanguage: 'it' }]
    const d = diagnose([card('c1', 'il gatto', 'A')], ['la mela'], outside, 'it')
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'outOfScope', word: 'la mela', cardId: 'c9', fromDeckName: 'Fruit' })
  })

  it('reports a document word that exists nowhere as missing', () => {
    const d = diagnose([card('c1', 'il gatto', 'A')], ['zzzz'], [], 'it')
    expect(d).toHaveLength(1)
    expect(d[0]).toMatchObject({ kind: 'missing', word: 'zzzz' })
  })

  it('says nothing about a document word that IS in scope', () => {
    expect(diagnose([card('c1', 'il gatto', 'A')], ['Il Gatto'], [], 'it')).toEqual([])
  })

  it('reports a repeated document word once', () => {
    const d = diagnose([], ['zzzz', 'zzzz', 'ZZZZ'], [], 'it')
    expect(d).toHaveLength(1)
  })
})

describe('applyPolicy', () => {
  const diags = diagnose(
    [card('c1', 'il gatto', 'A'), card('c2', 'il gatto', 'B', 'd2')],
    ['zzzz'], [], 'it',
  )
  it('drops duplicates when told to ignore them', () => {
    expect(applyPolicy(diags, { ...ALLOW, ignoreDuplicates: true }).map(d => d.kind)).toEqual(['missing'])
  })
  it('drops missing words when told to ignore them', () => {
    expect(applyPolicy(diags, { ...ALLOW, ignoreMissing: true }).map(d => d.kind)).toEqual(['duplicate'])
  })
  it('never drops out-of-scope — it is an offer, not noise', () => {
    const withOutside = diagnose([], ['la mela'], [{ cardId: 'c9', front: 'la mela', back: 'apple', deckId: 'd9', deckName: 'Fruit', sourceLanguage: 'it' }], 'it')
    const kept = applyPolicy(withOutside, { ignoreDuplicates: true, ignoreMissing: true, allowPullIn: true })
    expect(kept.map(d => d.kind)).toEqual(['outOfScope'])
  })
})

describe('orderSteps', () => {
  it('creates folders, then moves folders, decks, and finally cards', () => {
    const steps: MigrationStep[] = [
      { kind: 'moveCard', cardId: 'c1', front: 'a', back: 'b', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['Food', 'Fruit'], reason: '' },
      { kind: 'moveDeck', deckId: 'd2', deckName: 'Fruit', toFolder: ['Food'], reason: '' },
      { kind: 'createFolder', path: ['Food'], reason: '' },
      { kind: 'moveFolder', folderId: 'f1', folderName: 'Verbs', toParent: ['Grammar'], reason: '' },
    ]
    expect(orderSteps(steps).map(s => s.kind)).toEqual(['createFolder', 'moveFolder', 'moveDeck', 'moveCard'])
  })

  it('creates a parent folder before its child', () => {
    const steps: MigrationStep[] = [
      { kind: 'createFolder', path: ['Food', 'Fruit'], reason: '' },
      { kind: 'createFolder', path: ['Food'], reason: '' },
    ]
    expect(orderSteps(steps).map(s => (s as { path: string[] }).path.length)).toEqual([1, 2])
  })

  it('keeps the model’s order within a kind', () => {
    const steps: MigrationStep[] = [
      { kind: 'moveCard', cardId: 'c2', front: 'b', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['A'], reason: '' },
      { kind: 'moveCard', cardId: 'c1', front: 'a', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['A'], reason: '' },
    ]
    expect(orderSteps(steps).map(s => (s as { cardId: string }).cardId)).toEqual(['c2', 'c1'])
  })
})

describe('validatePlan', () => {
  const known = {
    cardIds: new Set(['c1']),
    deckIds: new Set(['d1']),
    folderIds: new Set(['f1']),
    pullInCardIds: new Set(['p1']),
    currentDeckPath: new Map([['c1', 'Food / Fruit']]),
  }
  const move = (over: Partial<Extract<MigrationStep, { kind: 'moveCard' }>>): MigrationStep => ({
    kind: 'moveCard', cardId: 'c1', front: 'a', back: 'b', fromDeckId: 'd1', fromDeckName: 'X',
    toDeck: ['Other'], reason: '', ...over,
  })

  it('drops a card id the model invented', () => {
    const { steps, dropped } = validatePlan([move({ cardId: 'nope' })], known)
    expect(steps).toEqual([])
    expect(dropped[0]!.why).toBe('unknown card')
  })

  it('drops an out-of-scope move when pull-in was not authorized', () => {
    const noPullIn = { ...known, pullInCardIds: new Set<string>() }
    const { steps, dropped } = validatePlan([move({ cardId: 'p1', pullIn: true })], noPullIn)
    expect(steps).toEqual([])
    expect(dropped[0]!.why).toBe('out-of-scope card not authorized')
  })

  it('allows an authorized pull-in', () => {
    expect(validatePlan([move({ cardId: 'p1', pullIn: true })], known).steps).toHaveLength(1)
  })

  it('drops a no-op move', () => {
    const { steps, dropped } = validatePlan([move({ toDeck: ['Food', 'Fruit'] })], known)
    expect(steps).toEqual([])
    expect(dropped[0]!.why).toBe('already there')
  })

  it('drops unknown decks and folders', () => {
    const bad: MigrationStep[] = [
      { kind: 'moveDeck', deckId: 'zz', deckName: 'X', toFolder: ['A'], reason: '' },
      { kind: 'moveFolder', folderId: 'zz', folderName: 'Y', toParent: ['A'], reason: '' },
    ]
    expect(validatePlan(bad, known).steps).toEqual([])
  })

  it('refuses to nest a folder inside itself', () => {
    const cycle: MigrationStep[] = [{ kind: 'moveFolder', folderId: 'f1', folderName: 'Verbs', toParent: ['Verbs', 'Sub'], reason: '' }]
    const { steps, dropped } = validatePlan(cycle, known)
    expect(steps).toEqual([])
    expect(dropped[0]!.why).toMatch(/inside itself/)
  })

  it('drops empty paths rather than creating a folder named ""', () => {
    expect(validatePlan([{ kind: 'createFolder', path: [], reason: '' }], known).steps).toEqual([])
    expect(validatePlan([move({ toDeck: [] })], known).steps).toEqual([])
  })
})

describe('deletions', () => {
  const del = (kind: 'deleteDeck' | 'deleteFolder', id: string, depth = 0): MigrationStep =>
    kind === 'deleteDeck'
      ? { kind, deckId: id, deckName: id, reason: '' }
      : { kind, folderId: id, folderName: id, depth, reason: '' }

  it('orders deletions LAST — decks before folders, deepest folders first', () => {
    const steps: MigrationStep[] = [
      del('deleteFolder', 'f-shallow', 0),
      del('deleteDeck', 'd1'),
      { kind: 'moveCard', cardId: 'c1', front: 'a', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['A'], reason: '' },
      del('deleteFolder', 'f-deep', 2),
      { kind: 'createFolder', path: ['A'], reason: '' },
    ]
    expect(orderSteps(steps).map(s => s.kind === 'deleteFolder' ? `${s.kind}:${s.depth}` : s.kind))
      .toEqual(['createFolder', 'moveCard', 'deleteDeck', 'deleteFolder:2', 'deleteFolder:0'])
  })

  it('validates delete ids against the scope, and drops repeats of the same container', () => {
    const known = {
      cardIds: new Set<string>(), deckIds: new Set(['d1']), folderIds: new Set(['f1']),
      pullInCardIds: new Set<string>(),
    }
    const { steps, dropped } = validatePlan([
      del('deleteDeck', 'd1'), del('deleteDeck', 'd1'),
      del('deleteDeck', 'zz'), del('deleteFolder', 'f1'), del('deleteFolder', 'qq'),
    ], known)
    expect(steps.map(s => s.kind)).toEqual(['deleteDeck', 'deleteFolder'])
    expect(dropped.map(d => d.why)).toEqual(['already being deleted', 'unknown deck', 'unknown folder'])
  })

  it('groups deletions into a Cleanup section at the end', () => {
    const groups = groupPlan([
      { kind: 'createFolder', path: ['A'], reason: '' },
      { kind: 'moveCard', cardId: 'c1', front: 'a', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['A'], reason: '' },
      del('deleteDeck', 'd9'),
    ])
    expect(groups.map(g => g.label)).toEqual(['Structure', 'A', 'Cleanup'])
    expect(groups[2]!.steps).toHaveLength(1)
  })
})

describe('groupPlan / countCardMoves', () => {
  const steps: MigrationStep[] = [
    { kind: 'createFolder', path: ['Food'], reason: '' },
    { kind: 'moveCard', cardId: 'c1', front: 'a', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['Food', 'Fruit'], reason: '' },
    { kind: 'moveCard', cardId: 'c2', front: 'b', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['Food', 'Fruit'], reason: '' },
    { kind: 'moveCard', cardId: 'c3', front: 'c', back: '', fromDeckId: 'd1', fromDeckName: 'X', toDeck: ['Verbs'], reason: '' },
  ]
  it('puts structure first, then groups card moves by destination', () => {
    const groups = groupPlan(steps)
    expect(groups[0]!.label).toBe('Structure')
    expect(groups[1]).toMatchObject({ label: 'Food / Fruit' })
    expect(groups[1]!.steps).toHaveLength(2)
    expect(groups[2]).toMatchObject({ label: 'Verbs' })
  })
  it('counts only card moves', () => {
    expect(countCardMoves(steps)).toBe(3)
  })
})

import type { Card, Deck, Grant, GatewayContext, AgentAction } from '@/domain'
import type { GatewayDeps } from '@/lib/agents/gateway'
import {
  listDecksInScope, searchCards, editCardText, createCard, deleteCard, splitTranslation,
  GatewayScopeError,
} from '@/lib/agents/gateway'

// ─── Fixtures ────────────────────────────────────────────────────────────────

function deck(id: string, src: string, tgt: string, folderId: string | null = null): Deck {
  return { id, ownerId: 'u', name: id, sourceLanguage: src, targetLanguage: tgt, folderId,
    pipelineId: 'p', gradingSettings: {} as Deck['gradingSettings'], isPublic: false, isPinned: false,
    position: 0, syncingComplete: true, createdAt: '', updatedAt: '', deletedAt: null } as Deck
}
function card(id: string, front: string, back: string): Card {
  return { id, ownerId: 'u', sourceLanguage: 'fr', targetLanguage: 'en', front, back, hints: [],
    choices: null, position: 0, createdAt: '', updatedAt: '', deletedAt: null } as Card
}

function makeDeps(decks: Deck[], deckCards: Record<string, Card[]>) {
  const recorded: Omit<AgentAction, 'id' | 'createdAt'>[] = []
  const updates:  { cardId: string; patch: Partial<Card> }[] = []
  const creates:  { deckId: string; front: string; back: string }[] = []
  const deletes:  string[] = []
  const allCards = () => Object.values(deckCards).flat()
  const deps: GatewayDeps = {
    listDecks:   async () => decks,
    listFolders: async () => [],
    listCards:   async deckId => deckCards[deckId] ?? [],
    getCard:     async cardId => allCards().find(c => c.id === cardId) ?? null,
    updateCard:  async (cardId, patch) => {
      const c = allCards().find(x => x.id === cardId)!
      Object.assign(c, patch); updates.push({ cardId, patch }); return c
    },
    createCard:  async (d, _owner, front, back) => {
      creates.push({ deckId: d.id, front, back })
      const c = card(`new-${creates.length}`, front, back)
      ;(deckCards[d.id] ??= []).push(c); return c
    },
    deleteCard:  async cardId => { deletes.push(cardId) },
    recordAction: async a => { recorded.push(a) },
  }
  return { deps, recorded, updates, creates, deletes }
}

const grant = (over: Partial<Grant> = {}): Grant => ({
  operations: ['edit', 'create', 'delete'], languages: [], folderIds: [], deckIds: [],
  dryRunOnly: false, ...over,
})
const ctxWith = (g: Grant): GatewayContext => ({ userId: 'u', grant: g, actor: 'test-agent' })

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('scope', () => {
  const decks = [deck('d-fr', 'fr', 'en'), deck('d-es', 'es', 'en')]
  const { deps } = makeDeps(decks, { 'd-fr': [], 'd-es': [] })

  it('language grant filters decks', async () => {
    const inScope = await listDecksInScope(ctxWith(grant({ languages: ['fr|en'] })), deps)
    expect(inScope.map(d => d.id)).toEqual(['d-fr'])
  })

  it('empty grant dimensions = unrestricted', async () => {
    const inScope = await listDecksInScope(ctxWith(grant()), deps)
    expect(inScope.map(d => d.id).sort()).toEqual(['d-es', 'd-fr'])
  })

  it('editing a deck outside the language scope throws', async () => {
    await expect(
      editCardText(ctxWith(grant({ languages: ['fr|en'] })), deps, { deckId: 'd-es', cardId: 'x', reason: 'r' }),
    ).rejects.toThrow(GatewayScopeError)
  })

  it('an operation not in the grant throws', async () => {
    await expect(
      editCardText(ctxWith(grant({ operations: ['create'] })), deps, { deckId: 'd-fr', cardId: 'x', reason: 'r' }),
    ).rejects.toThrow(/operation 'edit' not permitted/)
  })

  it('an expired grant throws', async () => {
    await expect(
      editCardText(ctxWith(grant({ expiresAt: '2000-01-01T00:00:00Z' })), deps, { deckId: 'd-fr', cardId: 'x', reason: 'r' }),
    ).rejects.toThrow(/expired/)
  })
})

describe('editCardText', () => {
  const setup = () => makeDeps([deck('d-fr', 'fr', 'en')], { 'd-fr': [card('c1', 'salut', 'hi/hello')] })

  it('dry-run proposes without writing', async () => {
    const { deps, updates, recorded } = setup()
    const res = await editCardText(ctxWith(grant({ dryRunOnly: true })), deps,
      { deckId: 'd-fr', cardId: 'c1', back: 'hi', reason: 'drop second gloss' })
    expect(res.applied).toBe(false)
    expect(res.proposals).toHaveLength(1)
    expect(res.proposals[0]).toMatchObject({ field: 'back', before: 'hi/hello', after: 'hi' })
    expect(updates).toHaveLength(0)
    expect(recorded).toHaveLength(0)
  })

  it('apply writes the card and an audit row', async () => {
    const { deps, updates, recorded } = setup()
    const res = await editCardText(ctxWith(grant()), deps,
      { deckId: 'd-fr', cardId: 'c1', back: 'hi', reason: 'drop second gloss' })
    expect(res.applied).toBe(true)
    expect(res.card?.back).toBe('hi')
    expect(updates).toEqual([{ cardId: 'c1', patch: { back: 'hi' } }])
    expect(recorded).toHaveLength(1)
    expect(recorded[0]).toMatchObject({ operation: 'edit', cardId: 'c1', actor: 'test-agent', dryRun: false })
  })

  it('a no-op edit (same text) neither proposes nor writes', async () => {
    const { deps, updates } = setup()
    const res = await editCardText(ctxWith(grant()), deps, { deckId: 'd-fr', cardId: 'c1', back: 'hi/hello', reason: 'x' })
    expect(res.applied).toBe(false)
    expect(res.proposals).toHaveLength(0)
    expect(updates).toHaveLength(0)
  })
})

describe('searchCards', () => {
  it('filters by substring on either side', async () => {
    const { deps } = makeDeps([deck('d-fr', 'fr', 'en')],
      { 'd-fr': [card('c1', 'salut', 'hi/hello'), card('c2', 'merci', 'thanks')] })
    const hits = await searchCards(ctxWith(grant()), deps, { deckId: 'd-fr', query: 'hello' })
    expect(hits.map(c => c.id)).toEqual(['c1'])
  })
})

describe('splitTranslation (salut = hi/hello)', () => {
  it('dry-run proposes an edit + one create per extra gloss', async () => {
    const { deps, updates, creates } = makeDeps([deck('d-fr', 'fr', 'en')],
      { 'd-fr': [card('c1', 'salut', 'hi/hello')] })
    const res = await splitTranslation(ctxWith(grant({ dryRunOnly: true })), deps,
      { deckId: 'd-fr', cardId: 'c1', primaryBack: 'hi', extraBacks: ['hello'], reason: 'split glosses' })
    expect(res.applied).toBe(false)
    expect(res.proposals.map(p => p.field)).toEqual(['back', 'create'])
    expect(updates).toHaveLength(0)
    expect(creates).toHaveLength(0)
  })

  it('apply edits the original and creates the sibling', async () => {
    const { deps, updates, creates } = makeDeps([deck('d-fr', 'fr', 'en')],
      { 'd-fr': [card('c1', 'salut', 'hi/hello')] })
    const res = await splitTranslation(ctxWith(grant()), deps,
      { deckId: 'd-fr', cardId: 'c1', primaryBack: 'hi', extraBacks: ['hello'], reason: 'split glosses' })
    expect(res.applied).toBe(true)
    expect(updates).toEqual([{ cardId: 'c1', patch: { back: 'hi' } }])
    expect(creates).toEqual([{ deckId: 'd-fr', front: 'salut', back: 'hello' }])
  })
})

describe('deleteCard', () => {
  it('soft-deletes under an apply grant', async () => {
    const { deps, deletes, recorded } = makeDeps([deck('d-fr', 'fr', 'en')], { 'd-fr': [card('c1', 'a', 'b')] })
    await deleteCard(ctxWith(grant()), deps, { deckId: 'd-fr', cardId: 'c1', reason: 'dup' })
    expect(deletes).toEqual(['c1'])
    expect(recorded[0]).toMatchObject({ operation: 'delete', cardId: 'c1' })
  })
})

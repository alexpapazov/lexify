import { scopeDeckIds, selectOfflineCardIds } from '@/lib/offline/download'
import { initialCardState } from '@/engine/pipeline'
import type { CardState } from '@/domain'

const deck = (id: string, folderId: string | null, src = 'es', tgt = 'en') => ({ id, folderId, sourceLanguage: src, targetLanguage: tgt })

describe('scopeDeckIds', () => {
  const decks = [deck('d1', null), deck('d2', 'f1'), deck('d3', 'f2'), deck('d4', null, 'it', 'en')]
  const folders = [{ id: 'f1', parentId: null }, { id: 'f2', parentId: 'f1' }]

  it('library → all decks', () => {
    expect(scopeDeckIds({ kind: 'library' }, decks, folders).sort()).toEqual(['d1', 'd2', 'd3', 'd4'])
  })
  it('language → decks of that pair', () => {
    expect(scopeDeckIds({ kind: 'language', source: 'es', target: 'en' }, decks, folders).sort()).toEqual(['d1', 'd2', 'd3'])
  })
  it('deck → just that deck', () => {
    expect(scopeDeckIds({ kind: 'deck', deckId: 'd2' }, decks, folders)).toEqual(['d2'])
  })
  it('folder → the folder and its descendants', () => {
    // f1 contains d2; f2 (child of f1) contains d3 → both included
    expect(scopeDeckIds({ kind: 'folder', folderId: 'f1' }, decks, folders).sort()).toEqual(['d2', 'd3'])
  })
})

describe('selectOfflineCardIds', () => {
  const now = new Date('2026-07-18T00:00:00Z').getTime()
  const fwd = (cardId: string, over: Partial<CardState>): CardState => ({ ...initialCardState('u', cardId, 'p'), ...over })
  const days = (n: number) => new Date(now + n * 86_400_000).toISOString()

  it('includes unlearned (no state) and learning (not graduated) cards', () => {
    const cards = [{ id: 'new' }, { id: 'learning' }]
    const states = [fwd('learning', { graduated: false })]
    const sel = selectOfflineCardIds(cards, states, now, 7)
    expect(sel.has('new')).toBe(true)
    expect(sel.has('learning')).toBe(true)
  })
  it('includes graduated cards due within the window, excludes far-future ones', () => {
    const cards = [{ id: 'soon' }, { id: 'later' }]
    const states = [
      fwd('soon',  { graduated: true, dueAt: days(3) }),
      fwd('later', { graduated: true, dueAt: days(30) }),
    ]
    const sel = selectOfflineCardIds(cards, states, now, 7)
    expect(sel.has('soon')).toBe(true)
    expect(sel.has('later')).toBe(false)
  })
  it('skips dormant graduated cards', () => {
    const cards = [{ id: 'dorm' }]
    const states = [fwd('dorm', { graduated: true, dormant: true, dueAt: days(1) })]
    expect(selectOfflineCardIds(cards, states, now, 7).has('dorm')).toBe(false)
  })
  it('includes a graduated card whose reverse (recall) is due soon even if production is far off', () => {
    const cards = [{ id: 'rev' }]
    const states = [
      fwd('rev', { graduated: true, dueAt: days(40) }),
      { ...initialCardState('u', 'rev', 'p'), reviewDirection: 'reverse' as const, graduated: true, recallDueAt: days(2) },
    ]
    expect(selectOfflineCardIds(cards, states, now, 7).has('rev')).toBe(true)
  })
})

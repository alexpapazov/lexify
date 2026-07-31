import { findDuplicates, applyProposal } from '@/lib/agents/cardEditor'

const c = (cardId: string, front: string, back: string, deckId = 'd1') =>
  ({ cardId, deckId, front, back, sourceLanguage: 'es' })

describe('findDuplicates — front+back mode (default)', () => {
  it('emits ONE proposal per group, carrying every copy', () => {
    const out = findDuplicates([
      c('1', '세수하다', 'to wash face'),
      c('2', '세수하다', 'to wash face'),   // exact dup of 1
      c('3', '세안하다', 'to wash face'),   // same gloss, different front → NOT a dup
    ], { mode: 'front-back' })
    expect(out).toHaveLength(1)
    expect(out[0]!.action).toBe('dedupe')
    expect(out[0]!.group!.map(g => g.cardId)).toEqual(['1', '2'])
    expect(out[0]!.keepCardId).toBe('1')
  })

  it('groups three copies into a single proposal, not two', () => {
    const out = findDuplicates([c('1', 'gato', 'cat'), c('2', 'gato', 'cat'), c('3', 'gato', 'cat')],
      { mode: 'front-back' })
    expect(out).toHaveLength(1)
    expect(out[0]!.group).toHaveLength(3)
  })

  it('normalizes case/whitespace', () => {
    expect(findDuplicates([c('1', 'gato', 'cat'), c('2', ' Gato ', 'CAT')], { mode: 'front-back' })).toHaveLength(1)
  })

  it('does NOT collide when front/back word-split differs', () => {
    // "a b" / "c"  vs  "a" / "b c" must be DISTINCT (separator collision guard)
    expect(findDuplicates([c('1', 'a b', 'c'), c('2', 'a', 'b c')], { mode: 'front-back' })).toHaveLength(0)
  })

  it('treats a shared card (same cardId in 2 decks) as one card, not a duplicate', () => {
    expect(findDuplicates([c('1', 'gato', 'cat', 'd1'), c('1', 'gato', 'cat', 'd2')], { mode: 'front-back' })).toHaveLength(0)
  })

  it('does NOT group cards that merely share a front', () => {
    expect(findDuplicates([c('1', 'vino', 'wine'), c('2', 'vino', 'he came')], { mode: 'front-back' })).toHaveLength(0)
  })
})

describe('findDuplicates — front mode', () => {
  it('groups the same word regardless of gloss', () => {
    const out = findDuplicates([c('1', 'cielo', 'sky'), c('2', 'cielo', 'heaven')], { mode: 'front' })
    expect(out).toHaveLength(1)
    expect(out[0]!.group!.map(g => g.back)).toEqual(['sky', 'heaven'])
  })

  it('matches across articles, case and grammatical tags', () => {
    expect(findDuplicates([c('1', 'el pan', 'bread'), c('2', 'Pan (m)', 'loaf')], { mode: 'front' })).toHaveLength(1)
  })

  it('leaves genuinely different words alone', () => {
    expect(findDuplicates([c('1', 'pan', 'bread'), c('2', 'pana', 'corduroy')], { mode: 'front' })).toHaveLength(0)
  })

  it('skips cards whose front normalizes to nothing', () => {
    expect(findDuplicates([c('1', '  ', 'a'), c('2', '  ', 'b')], { mode: 'front' })).toHaveLength(0)
  })
})

describe('findDuplicates — keeper selection', () => {
  const group = [c('fresh', 'gato', 'cat'), c('studied', 'gato', 'cat')]

  it('keeps the copy with the most review history', () => {
    const out = findDuplicates(group, { mode: 'front', rank: id => (id === 'studied' ? 10 : 0) })
    expect(out[0]!.keepCardId).toBe('studied')
  })

  it('falls back to scan order when ranks tie', () => {
    expect(findDuplicates(group, { mode: 'front' })[0]!.keepCardId).toBe('fresh')
    expect(findDuplicates(group, { mode: 'front', rank: () => 5 })[0]!.keepCardId).toBe('fresh')
  })

  it('always includes the keeper in the group', () => {
    const out = findDuplicates(group, { mode: 'front', rank: id => (id === 'studied' ? 10 : 0) })
    expect(out[0]!.group!.map(g => g.cardId)).toContain(out[0]!.keepCardId)
  })
})

describe('applyProposal — dedupe groups', () => {
  it('refuses a group with nothing to delete rather than silently doing nothing', async () => {
    await expect(applyProposal('u1', {
      ...c('1', 'gato', 'cat'), action: 'dedupe', group: [c('1', 'gato', 'cat')], keepCardId: '1', reason: 'x',
    })).rejects.toThrow(/nothing to delete/)
  })
})

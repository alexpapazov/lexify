import { findDuplicates, planDedupeDeletions } from '@/lib/agents/cardEditor'

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

describe('planDedupeDeletions — the never-delete-the-last-copy guard', () => {
  const group = [c('a', 'gato', 'cat'), c('b', 'gato', 'cat'), c('x', 'gato', 'cat')]
  const allAlive = () => true

  it('deletes every live copy except the keeper', () => {
    const { keep, doomed } = planDedupeDeletions(group, 'b', allAlive)
    expect(keep.cardId).toBe('b')
    expect(doomed.map(d => d.cardId)).toEqual(['a', 'x'])
  })

  it('ignores copies that have already been deleted', () => {
    const { doomed } = planDedupeDeletions(group, 'b', id => id !== 'x')
    expect(doomed.map(d => d.cardId)).toEqual(['a'])
  })

  it('REFUSES when the chosen keeper is already gone — otherwise the word vanishes entirely', () => {
    expect(() => planDedupeDeletions(group, 'b', id => id !== 'b'))
      .toThrow(/copy you chose to keep has already been deleted/)
  })

  it('REFUSES when fewer than two copies remain alive', () => {
    expect(() => planDedupeDeletions(group, 'a', id => id === 'a'))
      .toThrow(/Only one copy is still there/)
    expect(() => planDedupeDeletions(group, 'a', () => false))
      .toThrow(/Only one copy is still there/)
  })

  it('REFUSES a group of one', () => {
    expect(() => planDedupeDeletions([c('a', 'gato', 'cat')], 'a', allAlive))
      .toThrow(/Only one copy is still there/)
  })

  it('never returns the keeper among the doomed, whatever the liveness map says', () => {
    for (const keepId of ['a', 'b', 'x']) {
      const { keep, doomed } = planDedupeDeletions(group, keepId, allAlive)
      expect(doomed.map(d => d.cardId)).not.toContain(keep.cardId)
      expect(doomed).toHaveLength(2)
    }
  })
})

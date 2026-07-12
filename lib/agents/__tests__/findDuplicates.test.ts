import { findDuplicates } from '@/lib/agents/cardEditor'
const c = (cardId: string, front: string, back: string, deckId = 'd1') => ({ cardId, deckId, front, back })

describe('findDuplicates', () => {
  it('flags true duplicates (front AND back match), proposing delete of all but one', () => {
    const out = findDuplicates([
      c('1', '세수하다', 'to wash face'),
      c('2', '세수하다', 'to wash face'),   // exact dup of 1
      c('3', '세안하다', 'to wash face'),   // same gloss, different front → NOT a dup
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.cardId).toBe('2')
    expect(out[0]!.action).toBe('delete')
  })
  it('normalizes case/whitespace', () => {
    expect(findDuplicates([c('1', 'gato', 'cat'), c('2', ' Gato ', 'CAT')])).toHaveLength(1)
  })
  it('does NOT collide when front/back word-split differs', () => {
    // "a b" / "c"  vs  "a" / "b c" must be DISTINCT (separator collision guard)
    expect(findDuplicates([c('1', 'a b', 'c'), c('2', 'a', 'b c')])).toHaveLength(0)
  })
  it('treats a shared card (same cardId in 2 decks) as one card, not a duplicate', () => {
    expect(findDuplicates([c('1', 'gato', 'cat', 'd1'), c('1', 'gato', 'cat', 'd2')])).toHaveLength(0)
  })
})

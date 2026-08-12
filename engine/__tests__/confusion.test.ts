import { findConfusedSibling, confusionPenalty, normalizeForMatch, confusionKind, classifyIntraTags, editRatio, interleaveConfusablePairs, CONFUSION_STABILITY_FACTOR } from '@/engine/confusion'
import type { GradingSettings } from '@/domain'

const settings = (): GradingSettings => ({
  gradingMode: 'flexible', ignoreAccents: false, ignoreCapitalization: true, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: false,
  commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false, answerLanguage: 'bg',
})

const sibs = [
  { cardId: 'A', front: 'занаятчия', sourceLanguage: 'bg' },   // artisan
  { cardId: 'B', front: 'куче',      sourceLanguage: 'bg' },   // dog — clearly a different word
  { cardId: 'C', front: 'especie',   sourceLanguage: 'es' },
]

describe('findConfusedSibling', () => {
  it('flags typing a different real word that matches another card', () => {
    // Card A wanted "занаятчия"; user typed "куче", which is card B.
    expect(findConfusedSibling('куче', 'занаятчия', 'A', sibs, settings())).toBe('B')
  })
  it('ignores a mere typo (not a different word)', () => {
    // one-letter slip on the expected word → not a different-word mistake → no match
    expect(findConfusedSibling('занаятчиа', 'занаятчия', 'A', sibs, settings())).toBeNull()
  })
  it('ignores a wrong word that matches no other card', () => {
    expect(findConfusedSibling('котка', 'занаятчия', 'A', sibs, settings())).toBeNull()
  })
  it('never matches the current card itself', () => {
    expect(findConfusedSibling('занаятчия', 'занаятчия', 'A', sibs, settings())).toBeNull()
  })
})

describe('confusionPenalty', () => {
  it('halves stability, bumps difficulty, and yields a shorter interval', () => {
    const p = confusionPenalty({ difficulty: 5, stability: 20 }, 0.9)!
    expect(p.stability).toBeCloseTo(20 * CONFUSION_STABILITY_FACTOR, 6)
    expect(p.difficulty).toBe(6)
    expect(p.intervalDays).toBeLessThan(20)
    expect(p.intervalDays).toBeGreaterThanOrEqual(1)
  })
  it('clamps difficulty at 10 and floors stability at 0.5', () => {
    const p = confusionPenalty({ difficulty: 9.5, stability: 0.6 }, 0.9)!
    expect(p.difficulty).toBe(10)
    expect(p.stability).toBe(0.5)
  })
  it('returns null when the card has no FSRS state', () => {
    expect(confusionPenalty({ difficulty: null, stability: null })).toBeNull()
  })
})

describe('normalizeForMatch', () => {
  it('drops gender tags and case', () => {
    expect(normalizeForMatch('Занаятчия (m)')).toBe(normalizeForMatch('занаятчия'))
  })
})

describe('confusionKind', () => {
  it('same learned language → intra, different → inter', () => {
    expect(confusionKind('ko', 'ko')).toBe('intra')
    expect(confusionKind('es', 'ko')).toBe('inter')
  })
})

describe('editRatio (NFD, phoneme-level)', () => {
  it('rates Hangul 발/팔 as close (differ by one jamo)', () => {
    expect(editRatio('발', '팔')).toBeGreaterThanOrEqual(0.6)
  })
  it('rates unrelated words as far', () => {
    expect(editRatio('la manta', 'la sabana')).toBeLessThan(0.6)
  })
})

describe('classifyIntraTags', () => {
  it('tags phonetically-close pairs "phonetic"', () => {
    expect(classifyIntraTags({ frontA: '발', frontB: '팔' })).toContain('phonetic')
  })
  it('tags cards learned within the window "temporal"', () => {
    const tags = classifyIntraTags({ frontA: 'la manta', frontB: 'la sábana', introducedA: '2026-07-10', introducedB: '2026-07-11' })
    expect(tags).toContain('temporal')
    expect(tags).not.toContain('phonetic')   // semantically similar, not orthographically
  })
  it('returns empty (unclassified) when nothing deterministic applies', () => {
    expect(classifyIntraTags({ frontA: 'la manta', frontB: 'la sábana', introducedA: '2026-01-01', introducedB: '2026-07-01' })).toEqual([])
  })
})

describe('interleaveConfusablePairs', () => {
  const q = (id: string) => ({ card: { id } })
  it('pulls a confusable pair adjacent (at the first member position)', () => {
    const queue = [q('A'), q('X'), q('Y'), q('B'), q('Z')]
    const out = interleaveConfusablePairs(queue, [{ cardAId: 'A', cardBId: 'B' }])
    expect(out.map(i => i.card.id)).toEqual(['A', 'B', 'X', 'Y', 'Z'])
  })
  it('clusters a connected group A-B-C together', () => {
    const queue = [q('A'), q('X'), q('B'), q('Y'), q('C')]
    const out = interleaveConfusablePairs(queue, [{ cardAId: 'A', cardBId: 'B' }, { cardAId: 'B', cardBId: 'C' }])
    expect(out.map(i => i.card.id)).toEqual(['A', 'B', 'C', 'X', 'Y'])
  })
  it('ignores links whose other card is not in the queue', () => {
    const queue = [q('A'), q('X')]
    expect(interleaveConfusablePairs(queue, [{ cardAId: 'A', cardBId: 'B' }]).map(i => i.card.id)).toEqual(['A', 'X'])
  })
  it('no links → unchanged', () => {
    const queue = [q('A'), q('B')]
    expect(interleaveConfusablePairs(queue, [])).toBe(queue)
  })
})

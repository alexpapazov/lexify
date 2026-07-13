import { findConfusedSibling, confusionPenalty, normalizeForMatch, CONFUSION_STABILITY_FACTOR } from '@/engine/confusion'
import type { GradingSettings } from '@/domain'

const settings = (): GradingSettings => ({
  gradingMode: 'flexible', ignoreAccents: false, ignoreCapitalization: true, ignoreMinorTypos: false,
  ignoreDefiniteArticles: false, requireParentheticalContent: false,
  slashAlternativesMode: 'accept_any', commaAlternativesMode: 'split_into_cards',
  autoPlayAudio: false, answerLanguage: 'bg',
})

const sibs = [
  { cardId: 'A', front: 'занаятчия' },   // artisan
  { cardId: 'B', front: 'куче' },        // dog — clearly a different word
  { cardId: 'C', front: 'especie' },
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
